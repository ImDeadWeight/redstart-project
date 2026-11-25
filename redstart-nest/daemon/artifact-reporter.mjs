'use strict'

// =============================================================================
// Redstart Nest — the artifact_check reporter (artifacts plan §9)
// =============================================================================
// In chat-ui, artifact_check loads the artifact in a hidden sandboxed frame,
// and the frame is cross-origin: the host cannot look inside it, or capture
// it. So when the view token asks for it (report=1), the content listener puts
// this script first in every HTML page it serves. It tells the parent window
// what a page check would see, as data, by postMessage:
//
//   { source: 'redstart-artifact', type: 'event', kind, text }
//       kind: 'error' (uncaught), 'rejection', 'console' (error/warn),
//             'resource' (a <script>/<link>/<img> that failed), 'fetch'
//   { source: 'redstart-artifact', type: 'ready' }          after load
//   { source: 'redstart-artifact', type: 'summary', ... }   on request:
//       title, text (visible, capped), elements, canvases, images, links,
//       buttons, forms, height, width
//
// and answers one message from the parent:
//   { source: 'redstart-host', type: 'summary-request', waitMs }
//
// The host treats all of it as untrusted data (it comes from model-written
// pages): it checks event.source, caps sizes and counts, and formats it as
// text for the model. Nothing here can reach anything the page itself
// cannot; it only reports.
// =============================================================================

/** The script, minified by hand; kept small because it rides in every checked page. */
export const REPORTER_SCRIPT = `(function(){
var P=window.parent,S='redstart-artifact',n=0,MAX=60;
function cap(s,k){s=String(s==null?'':s);return s.length>k?s.slice(0,k)+'…':s}
function post(m){try{m.source=S;P.postMessage(m,'*')}catch(e){}}
function ev(kind,text){if(n++<MAX)post({type:'event',kind:kind,text:cap(text,500)})}
addEventListener('error',function(e){var t=e.target;
 if(t&&t!==window&&(t.src||t.href)){ev('resource',(t.tagName||'').toLowerCase()+' '+(t.src||t.href));return}
 ev('error',(e.message||'error')+(e.filename?' ('+String(e.filename).split('/').pop()+':'+e.lineno+')':''))},true);
addEventListener('unhandledrejection',function(e){var r=e.reason;ev('rejection',r&&r.message?r.message:r)});
['error','warn'].forEach(function(k){var o=console[k];console[k]=function(){
 try{ev('console',k+': '+Array.prototype.map.call(arguments,function(a){try{return typeof a==='string'?a:JSON.stringify(a)}catch(x){return String(a)}}).join(' '))}catch(x){}
 return o.apply(console,arguments)}});
if(window.fetch){var f=window.fetch;window.fetch=function(u){return f.apply(this,arguments).then(function(r){if(!r.ok)ev('fetch',r.status+' '+(u&&u.url||u));return r},function(e){ev('fetch','failed '+(u&&u.url||u)+': '+(e&&e.message));throw e})}}
function summary(){var b=document.body,q=function(s){return document.querySelectorAll(s).length};
 return{type:'summary',title:cap(document.title,200),text:cap(b?b.innerText.replace(/\\s+/g,' ').trim():'',2000),
 elements:q('*'),canvases:q('canvas'),images:q('img,svg'),links:q('a[href]'),buttons:q('button,[role=button],input[type=button],input[type=submit]'),forms:q('form'),
 height:Math.round(document.documentElement.scrollHeight),width:Math.round(document.documentElement.scrollWidth)}}
addEventListener('message',function(e){var d=e.data;if(e.source!==P||!d||d.source!=='redstart-host'||d.type!=='summary-request')return;
 setTimeout(function(){post(summary())},Math.min(Math.max(+d.waitMs||0,0),10000))});
if(document.readyState==='complete')post({type:'ready'});else addEventListener('load',function(){post({type:'ready'})});
})();`

/**
 * The page with the reporter as its first script: right after <head> (or
 * <html>, or at the very start), so it is listening before any page script
 * runs and fails.
 */
export function injectReporter(html) {
  const tag = `<script>${REPORTER_SCRIPT}</script>`
  const head = /<head\b[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
  const root = /<html\b[^>]*>/i.exec(html)
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length)
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length)
  return tag + html
}
