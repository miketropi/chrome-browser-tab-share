import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { ClientMessageSchema, type ClientMessage, type ServerMessage } from '@tab-share/protocol';
import { SessionError, type Guest, type Session, type SessionStore } from './sessions.js';
import { createIceServers, type TurnConfig } from './turn.js';

type Client = { ws: WebSocket; role: 'host'|'guest'; session: Session; guest?: Guest; signalCount: number; signalWindow: number; messageCount: number; messageWindow: number; alive: boolean };
const encode = (message: ServerMessage): string => JSON.stringify(message);
export class SignalingServer {
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 65_536, perMessageDeflate: false });
  private readonly clients = new Set<Client>();
  private readonly unauthenticatedByIp = new Map<string, number>();
  constructor(private readonly store: SessionStore, private readonly origins: Set<string>, private readonly turn: TurnConfig) {
    this.wss.on('connection', (ws, request) => this.accept(ws, request));
    setInterval(() => this.heartbeat(), 5_000).unref();
  }
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = request.headers.origin;
    if (!origin || !this.origins.has(origin)) { socket.destroy(); return; }
    const ip = request.socket.remoteAddress ?? 'unknown';
    if ((this.unauthenticatedByIp.get(ip) ?? 0) >= 5) { socket.destroy(); return; }
    this.unauthenticatedByIp.set(ip, (this.unauthenticatedByIp.get(ip) ?? 0) + 1);
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request));
  }
  notifyPending(session: Session, guest: Guest): void { this.sendHost(session, { v:1, type:'pending-guest', guestId:guest.id, name:guest.name, comparisonCode:guest.comparisonCode }); }
  private accept(ws: WebSocket, request: IncomingMessage): void {
    const ip = request.socket.remoteAddress ?? 'unknown';
    let client: Client | undefined;
    const timer = setTimeout(() => ws.close(4001, 'authentication timeout'), 5_000);
    ws.on('pong', () => { if (client) client.alive = true; });
    ws.on('message', (raw) => {
      try {
        const message = ClientMessageSchema.parse(JSON.parse(raw.toString()));
        if (!client) {
          if (message.type !== 'auth') throw new SessionError('UNAUTHORIZED');
          const host = message.role === 'host' ? this.store.authenticateHost(message.sessionId, message.token) : null;
          const found = message.role === 'guest' ? this.store.authenticateGuest(message.sessionId, message.token) : null;
          if (!host && !found) throw new SessionError('UNAUTHORIZED');
          const authenticated: Client = found
            ? { ws, role: message.role, session: found.session, guest: found.guest, signalCount: 0, signalWindow: Date.now(), messageCount: 0, messageWindow: Date.now(), alive: true }
            : { ws, role: message.role, session: host!, signalCount: 0, signalWindow: Date.now(), messageCount: 0, messageWindow: Date.now(), alive: true };
          client = authenticated;
          this.clients.add(authenticated); clearTimeout(timer); this.unauthenticatedByIp.set(ip, Math.max(0, (this.unauthenticatedByIp.get(ip) ?? 1) - 1)); this.snapshot(authenticated);
          // The host may approve before this socket authenticates, so re-send the approval and
          // tell the host to (re)offer: an offer sent to a guest that was not yet connected is
          // dropped, and without this the guest would sit on "negotiating" forever.
          if (authenticated.guest?.state === 'approved') {
            this.sendGuest(authenticated.session, authenticated.guest.id, { v:1, type:'approved', guestId: authenticated.guest.id });
            this.sendHost(authenticated.session, { v:1, type:'ready', guestId: authenticated.guest.id });
          }
          return;
        }
        this.route(client, message);
      } catch (error) { this.send(ws, { v:1, type:'error', code:error instanceof SessionError ? error.code : 'INVALID_MESSAGE' }); }
    });
    ws.on('close', () => { clearTimeout(timer); if (!client) { this.unauthenticatedByIp.set(ip, Math.max(0, (this.unauthenticatedByIp.get(ip) ?? 1) - 1)); return; } this.clients.delete(client); if (client.role === 'host') this.end(client.session, 'Host disconnected'); else if (client.guest) { this.store.remove(client.session, client.guest.id); this.broadcastControl(client.session); } });
  }
  private route(client: Client, message: ClientMessage): void {
    const hostOnly = ['approve','reject','kick','grant-control','revoke-control','rotate-invite','end-session'] as const;
    if (hostOnly.includes(message.type as typeof hostOnly[number]) && client.role !== 'host') throw new SessionError('UNAUTHORIZED');
    switch (message.type) {
      case 'approve': { const guest=this.store.approve(client.session,message.guestId); const approved:ServerMessage={v:1,type:'approved',guestId:guest.id}; this.sendGuest(client.session,guest.id,approved); this.sendHost(client.session,approved); this.snapshot(client); break; }
      case 'reject': case 'kick': { const guest=this.store.remove(client.session,message.guestId); if (guest) this.sendGuest(client.session,guest.id,{v:1,type:message.type==='reject'?'rejected':'removed'}); this.snapshot(client); break; }
      case 'request-control': if (client.guest?.state==='approved') this.sendHost(client.session,{v:1,type:'request-control',guestId:client.guest.id}); else throw new SessionError('UNAUTHORIZED'); break;
      case 'grant-control': this.store.grant(client.session,message.guestId); this.broadcastControl(client.session); break;
      case 'revoke-control': this.store.revoke(client.session); this.broadcastControl(client.session); break;
      case 'rotate-invite': { const invite=this.store.rotate(client.session); this.send(client.ws,{v:1,type:'invite',url:invite.inviteUrl,expiresAt:client.session.inviteExpiresAt}); break; }
      case 'end-session': this.end(client.session,'Host ended sharing'); break;
      case 'turn-credentials': { if (client.role==='guest' && client.guest?.id!==message.guestId) throw new SessionError('UNAUTHORIZED'); const guest=client.session.guests.get(message.guestId); if (!guest || guest.state!=='approved') throw new SessionError('UNAUTHORIZED'); this.send(client.ws,createIceServers(this.turn,message.guestId)); break; }
      case 'guest-message': {
        if (client.role !== 'guest' || !client.guest || client.guest.state !== 'approved') throw new SessionError('UNAUTHORIZED');
        const now = Date.now();
        if (now - client.messageWindow >= 60_000) { client.messageWindow = now; client.messageCount = 0; }
        if (++client.messageCount > 5) throw new SessionError('RATE_LIMITED');
        this.sendHost(client.session, { v:1, type:'guest-message', guestId: client.guest.id, name: client.guest.name, text: message.text, at: now });
        break;
      }
      case 'ready': {
        if (client.role !== 'guest' || !client.guest || client.guest.state !== 'approved') throw new SessionError('UNAUTHORIZED');
        this.sendHost(client.session, { v:1, type:'ready', guestId: client.guest.id });
        break;
      }
      case 'signal': this.signal(client,message); break;
    }
  }
  private signal(client: Client, message: Extract<ClientMessage,{type:'signal'}>): void {
    const now=Date.now(); if(now-client.signalWindow>=60_000){client.signalWindow=now;client.signalCount=0;} if(++client.signalCount>300) throw new SessionError('RATE_LIMITED');
    const guest=client.session.guests.get(message.guestId); if(!guest||guest.state!=='approved') throw new SessionError('UNAUTHORIZED');
    if(client.role==='host'){if(message.kind==='answer')throw new SessionError('UNAUTHORIZED');this.sendGuest(client.session,guest.id,message);}
    else {if(client.guest?.id!==message.guestId||message.kind==='offer')throw new SessionError('UNAUTHORIZED');this.sendHost(client.session,message);}
  }
  private snapshot(client: Client): void { const s=client.session; const guests=client.role==='host'?[...s.guests.values()].map(g=>({guestId:g.id,name:g.name,state:g.state,comparisonCode:g.comparisonCode})):client.guest?[{guestId:client.guest.id,name:client.guest.name,state:client.guest.state,comparisonCode:client.guest.comparisonCode}]:[]; this.send(client.ws,{v:1,type:'snapshot',sessionId:s.id,state:s.state,expiresAt:s.expiresAt,guests,controllerGuestId:s.controllerGuestId,controlEpoch:s.controlEpoch}); }
  private broadcastControl(s:Session):void{const m:ServerMessage={v:1,type:'control-state',controllerGuestId:s.controllerGuestId,controlEpoch:s.controlEpoch};for(const c of this.clients)if(c.session===s)this.send(c.ws,m);}
  private end(s:Session,reason:string):void{this.store.end(s);for(const c of [...this.clients])if(c.session===s){this.send(c.ws,{v:1,type:'ended',reason});c.ws.close(1000,reason);}}
  private sendHost(s:Session,m:ServerMessage):void{for(const c of this.clients)if(c.session===s&&c.role==='host')this.send(c.ws,m);}
  private sendGuest(s:Session,id:string,m:ServerMessage):void{for(const c of this.clients)if(c.session===s&&c.guest?.id===id)this.send(c.ws,m);}
  private send(ws:WebSocket,m:ServerMessage):void{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>1_048_576){ws.close(1009,'outbound overflow');return;}ws.send(encode(m));}
  private heartbeat():void{for(const c of this.clients){if(!c.alive){c.ws.terminate();continue;}c.alive=false;c.ws.ping();}}
}
