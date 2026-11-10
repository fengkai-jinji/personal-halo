/**
 * Signals are ephemeral. They contain only permitted metadata and extracted targets/tasks.
 * @typedef {{t:'meta',sid:string,title?:string,project?:string,model?:string,parentSid?:string,startedAt?:number,at?:number}
 * | {t:'turn_start'|'thinking'|'waiting'|'compact'|'activity',sid:string,at:number}
 * | {t:'text',sid:string,at:number,outTokens?:number,snippet?:string|null}
 * | {t:'tool_start',sid:string,at:number,tool:string,callId?:string,target?:string|null,files?:string[]}
 * | {t:'tool_end',sid:string,at:number,tool?:string,callId?:string,ok:boolean}
 * | {t:'turn_end',sid:string,at:number,ok:boolean}
 * | {t:'tokens',sid:string,at:number,input?:number,output?:number,reasoning?:number,cacheRead?:number,total?:number,mode:'cumulative'|'delta',streaming?:boolean}
 * | {t:'context',sid:string,at:number,used?:number,window?:number}
 * | {t:'tasks',sid:string,at:number,items:{text:string,status:'done'|'active'|'pending'|'cancelled'}[]}
 * | {t:'gone',sid:string}} Signal
 */
export {};
