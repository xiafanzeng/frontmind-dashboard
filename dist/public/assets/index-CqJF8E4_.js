import{c as h,r as l,av as H,j as u,z as w,P as I,G as V,J as y,v as P,s as x,y as N,a7 as _}from"./index-wE5qfHld.js";/**
 * @license lucide-react v0.453.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const Z=h("Check",[["path",{d:"M20 6 9 17l-5-5",key:"1gmf2c"}]]);/**
 * @license lucide-react v0.453.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ee=h("ChevronDown",[["path",{d:"m6 9 6 6 6-6",key:"qrunsl"}]]);/**
 * @license lucide-react v0.453.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const te=h("ChevronUp",[["path",{d:"m18 15-6-6-6 6",key:"153udz"}]]);/**
 * @license lucide-react v0.453.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const oe=h("Copy",[["rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2",key:"17jyea"}],["path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",key:"zix9uf"}]]);/**
 * @license lucide-react v0.453.0 - ISC
 *
 * This source code is licensed under the ISC license.
 * See the LICENSE file in the root directory of this source tree.
 */const ae=h("Plus",[["path",{d:"M5 12h14",key:"1ays0h"}],["path",{d:"M12 5v14",key:"s699le"}]]);var W=l.createContext(void 0);function ne(e){const t=l.useContext(W);return e||t||"ltr"}function re(e,[t,a]){return Math.min(a,Math.max(t,e))}const se=6,ce=128;function $(){return H.useSyncExternalStore(q,()=>!0,()=>!1)}function q(){return()=>{}}var M="Avatar",[U]=w(M),[B,b]=U(M),j=l.forwardRef((e,t)=>{const{__scopeAvatar:a,...n}=e,[s,o]=l.useState("idle");return u.jsx(B,{scope:a,imageLoadingStatus:s,onImageLoadingStatusChange:o,children:u.jsx(I.span,{...n,ref:t})})});j.displayName=M;var T="AvatarImage",J=l.forwardRef((e,t)=>{const{__scopeAvatar:a,src:n,onLoadingStatusChange:s=()=>{},...o}=e,d=b(T,a),r=K(n,o),i=V(f=>{s(f),d.onImageLoadingStatusChange(f)});return y(()=>{r!=="idle"&&i(r)},[r,i]),r==="loaded"?u.jsx(I.img,{...o,ref:t,src:n}):null});J.displayName=T;var D="AvatarFallback",O=l.forwardRef((e,t)=>{const{__scopeAvatar:a,delayMs:n,...s}=e,o=b(D,a),[d,r]=l.useState(n===void 0);return l.useEffect(()=>{if(n!==void 0){const i=window.setTimeout(()=>r(!0),n);return()=>window.clearTimeout(i)}},[n]),d&&o.imageLoadingStatus!=="loaded"?u.jsx(I.span,{...s,ref:t}):null});O.displayName=D;function k(e,t){return e?t?(e.src!==t&&(e.src=t),e.complete&&e.naturalWidth>0?"loaded":"loading"):"error":"idle"}function K(e,{referrerPolicy:t,crossOrigin:a}){const n=$(),s=l.useRef(null),o=n?(s.current||(s.current=new window.Image),s.current):null,[d,r]=l.useState(()=>k(o,e));return y(()=>{r(k(o,e))},[o,e]),y(()=>{const i=g=>()=>{r(g)};if(!o)return;const f=i("loaded"),A=i("error");return o.addEventListener("load",f),o.addEventListener("error",A),t&&(o.referrerPolicy=t),typeof a=="string"&&(o.crossOrigin=a),()=>{o.removeEventListener("load",f),o.removeEventListener("error",A)}},[o,a,t]),d}var X=j,Q=O;function le({className:e,...t}){return u.jsx(X,{"data-slot":"avatar",className:P("relative flex size-8 shrink-0 overflow-hidden rounded-full",e),...t})}function ie({className:e,...t}){return u.jsx(Q,{"data-slot":"avatar-fallback",className:P("bg-muted flex size-full items-center justify-center rounded-full",e),...t})}function ue(e){const t=e+"CollectionProvider",[a,n]=w(t),[s,o]=a(t,{collectionRef:{current:null},itemMap:new Map}),d=p=>{const{scope:c,children:S}=p,m=x.useRef(null),v=x.useRef(new Map).current;return u.jsx(s,{scope:c,itemMap:v,collectionRef:m,children:S})};d.displayName=t;const r=e+"CollectionSlot",i=_(r),f=x.forwardRef((p,c)=>{const{scope:S,children:m}=p,v=o(r,S),C=N(c,v.collectionRef);return u.jsx(i,{ref:C,children:m})});f.displayName=r;const A=e+"CollectionItemSlot",g="data-radix-collection-item",z=_(A),L=x.forwardRef((p,c)=>{const{scope:S,children:m,...v}=p,C=x.useRef(null),E=N(c,C),R=o(A,S);return x.useEffect(()=>(R.itemMap.set(C,{ref:C,...v}),()=>void R.itemMap.delete(C))),u.jsx(z,{[g]:"",ref:E,children:m})});L.displayName=A;function F(p){const c=o(e+"CollectionConsumer",p);return x.useCallback(()=>{const m=c.collectionRef.current;if(!m)return[];const v=Array.from(m.querySelectorAll(`[${g}]`));return Array.from(c.itemMap.values()).sort((R,G)=>v.indexOf(R.ref.current)-v.indexOf(G.ref.current))},[c.collectionRef,c.itemMap])}return[{Provider:d,Slot:f,ItemSlot:L},F,n]}export{le as A,Z as C,se as M,ae as P,ee as a,ce as b,re as c,ue as d,ie as e,te as f,oe as g,ne as u};
