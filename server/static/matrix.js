const c=document.getElementById("c"),x=c.getContext("2d");
let W,H,cols,drops;
const chars="アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF";
function init(){W=c.width=innerWidth;H=c.height=innerHeight;cols=Math.floor(W/16);drops=Array(cols).fill(1)}
init();onresize=init;
function draw(){
x.fillStyle="rgba(17,17,17,0.05)";x.fillRect(0,0,W,H);
for(let i=0;i<cols;i++){
const t=chars[Math.floor(Math.random()*chars.length)];
x.fillStyle="hsl("+((Date.now()/50+i*3)%360)+",70%,50%)";
x.font="15px monospace";
x.fillText(t,i*16,drops[i]*16);
if(drops[i]*16>H&&Math.random()>.975)drops[i]=0;
drops[i]++}}
setInterval(draw,50);
