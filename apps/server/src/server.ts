import { createServer } from 'node:http';
import { resolve } from 'node:path';
import express from 'express';
import { JoinRequestSchema } from '@tab-share/protocol';
import { SessionError, SessionStore } from './sessions.js';
import { SignalingServer } from './signaling.js';

const development = process.env.NODE_ENV !== 'production';
const required = (name: string): string => { const value=process.env[name]; if(!value) throw new Error(`${name} is required`); return value; };
const publicOrigin = process.env.PUBLIC_ORIGIN ?? (development ? 'http://localhost:5173' : required('PUBLIC_ORIGIN'));
const hostAccessKey = process.env.HOST_ACCESS_KEY ?? (development ? 'development-host-access-key-change-me' : required('HOST_ACCESS_KEY'));
const extensionIds=(process.env.ALLOWED_EXTENSION_IDS??'').split(',').map(v=>v.trim()).filter(Boolean);
if(!development && (!publicOrigin.startsWith('https://') || hostAccessKey.length<32 || !process.env.TURN_HOST || !process.env.TURN_SHARED_SECRET)) throw new Error('Production requires HTTPS and strong HOST/TURN secrets');
const allowedOrigins=new Set([publicOrigin,...extensionIds.map(id=>`chrome-extension://${id}`)]);
const store=new SessionStore({maxGuests:Number(process.env.MAX_GUESTS??4),maxSessions:Number(process.env.MAX_SESSIONS??10),sessionTtlMs:Number(process.env.SESSION_TTL_SECONDS??7200)*1000,inviteTtlMs:Number(process.env.INVITE_TTL_SECONDS??600)*1000},publicOrigin);
const turnConfig = process.env.TURN_HOST && process.env.TURN_SHARED_SECRET
  ? { host: process.env.TURN_HOST, secret: process.env.TURN_SHARED_SECRET, tlsPort: Number(process.env.TURN_TLS_PORT ?? 5349), development }
  : { tlsPort: Number(process.env.TURN_TLS_PORT ?? 5349), development };
const signaling=new SignalingServer(store,allowedOrigins,turnConfig);
const app=express(); app.disable('x-powered-by'); app.use(express.json({limit:'16kb'}));
app.use((req,res,next)=>{res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");const origin=req.headers.origin;if(origin&&allowedOrigins.has(origin)){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');res.setHeader('Access-Control-Allow-Headers','Authorization, Content-Type');res.setHeader('Access-Control-Allow-Methods','GET, POST, OPTIONS');}if(req.method==='OPTIONS'){res.sendStatus(origin&&allowedOrigins.has(origin)?204:403);return;}next();});
const creations=new Map<string,{at:number,count:number}>(); const joins=new Map<string,{at:number,count:number}>();
const rate=(map:Map<string,{at:number,count:number}>,key:string,limit:number):boolean=>{const now=Date.now();const current=map.get(key);if(!current||now-current.at>=60_000){map.set(key,{at:now,count:1});return true;}current.count++;return current.count<=limit;};
app.post('/api/sessions',(req,res)=>{try{const authorization=req.headers.authorization;if(authorization!==`Bearer ${hostAccessKey}`)throw new SessionError('UNAUTHORIZED');if(!rate(creations,authorization,5))throw new SessionError('RATE_LIMITED');const result=store.create();signaling.notifyPending;res.status(201).json({sessionId:result.session.id,hostToken:result.hostToken,inviteUrl:result.inviteUrl,expiresAt:result.session.expiresAt,inviteExpiresAt:result.session.inviteExpiresAt});}catch(error){respondError(res,error);}});
app.get('/api/extension-status',(req,res)=>{
  const extensionId=typeof req.query.id==='string'?req.query.id:'';
  res.json({allowed:extensionIds.includes(extensionId)});
});
app.post('/api/sessions/:sessionId/join',(req,res)=>{try{const ip=req.ip??'unknown';if(!rate(joins,ip,10))throw new SessionError('RATE_LIMITED');const body=JoinRequestSchema.parse(req.body);const result=store.join(req.params.sessionId,body.inviteToken,body.name);signaling.notifyPending(result.session,result.guest);res.status(201).json({guestId:result.guest.id,guestToken:result.guestToken,comparisonCode:result.guest.comparisonCode});}catch(error){respondError(res,error);}});
function respondError(res:express.Response,error:unknown):void{const code=error instanceof SessionError?error.code:'INVALID_MESSAGE';res.status(code==='UNAUTHORIZED'?401:code==='RATE_LIMITED'?429:code==='SESSION_ENDED'?410:400).json({error:code});}
if(!development){const web=resolve(process.cwd(),'apps/web/dist');app.use(express.static(web,{index:false}));app.get(['/','/join/:sessionId'],(_req,res)=>res.sendFile(resolve(web,'index.html')));}
const server=createServer(app);server.on('upgrade',(request,socket,head)=>{if(request.url!=='/ws'){socket.destroy();return;}signaling.upgrade(request,socket,head);});
const port=Number(process.env.PORT??3000);server.listen(port,'0.0.0.0',()=>console.log(`tab-share server listening on ${port}`));
