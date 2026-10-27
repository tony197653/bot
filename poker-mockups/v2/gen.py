# Throwaway mockups for portrait 6-max table (not repo code)
import os
OUT = os.path.dirname(os.path.abspath(__file__))

CSS = r"""
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:390px;height:844px;overflow:hidden}
body{position:relative;background:radial-gradient(ellipse at 50% 40%,#21392c 0%,#13231a 70%,#0d1912 100%);
 font-family:"Noto Sans CJK TC","Noto Serif CJK TC",sans-serif;color:#f3ead2}
.abs{position:absolute}
/* top bar */
.top{left:0;top:0;width:390px;height:40px;display:flex;align-items:center;justify-content:space-between;
 padding:0 14px;background:rgba(0,0,0,.28);border-bottom:1px solid rgba(255,255,255,.06)}
.top .t{font-size:14px;font-weight:700;letter-spacing:.5px}
.top .t small{font-weight:400;color:#c9bf9f;margin-left:8px;font-size:12px}
.menu{width:30px;height:30px;display:flex;flex-direction:column;justify-content:center;gap:4px;align-items:center}
.menu i{display:block;width:18px;height:2px;background:#e9dfc3;border-radius:2px}
/* table */
.rail{border-radius:50%;background:linear-gradient(160deg,#7a4a26,#4d2c14 55%,#6b3f1f);
 box-shadow:0 10px 30px rgba(0,0,0,.55), inset 0 2px 3px rgba(255,220,170,.25)}
.felt{position:absolute;inset:13px;border-radius:50%;
 background:radial-gradient(ellipse at 50% 42%,#2f8a52 0%,#1f6b3d 60%,#175632 100%);
 box-shadow:inset 0 0 0 2px rgba(214,180,90,.35), inset 0 6px 24px rgba(0,0,0,.45)}
/* cards */
.card{width:44px;height:62px;border-radius:6px;background:#fbf7ee;box-shadow:0 2px 5px rgba(0,0,0,.45);
 position:relative;font-family:"Noto Serif CJK TC",serif;color:#1d1d1d}
.card .r{position:absolute;left:5px;top:2px;font-size:17px;font-weight:700;line-height:1}
.card .s1{position:absolute;left:5px;top:20px;font-size:13px;line-height:1}
.card .s{position:absolute;right:5px;bottom:4px;font-size:24px;line-height:1}
.card.red{color:#c0262d}
.card.big{width:60px;height:84px;border-radius:8px}
.card.big .r{font-size:24px;left:6px;top:3px}.card.big .s1{font-size:16px;top:28px;left:7px}.card.big .s{font-size:32px}
.back{width:20px;height:28px;border-radius:3px;border:1.5px solid #f2e6d0;
 background:repeating-linear-gradient(45deg,#9e2a2b 0 3px,#7d1f22 3px 6px);box-shadow:0 1px 3px rgba(0,0,0,.5)}
.backs{display:flex}.backs .back+.back{margin-left:-8px;transform:rotate(8deg)}.backs .back:first-child{transform:rotate(-6deg)}
/* chips */
.chip{width:16px;height:16px;border-radius:50%;flex:none;
 background:radial-gradient(circle,#c8343a 0 38%,#fff 39% 44%,transparent 45%),
  repeating-conic-gradient(#c8343a 0 30deg,#f4efe6 30deg 60deg);
 box-shadow:0 1px 2px rgba(0,0,0,.6), inset 0 0 0 1.5px #a5272c}
.chip.blue{background:radial-gradient(circle,#2f5fb3 0 38%,#fff 39% 44%,transparent 45%),repeating-conic-gradient(#2f5fb3 0 30deg,#f4efe6 30deg 60deg);box-shadow:0 1px 2px rgba(0,0,0,.6), inset 0 0 0 1.5px #234a8f}
.bet{display:flex;align-items:center;gap:4px;height:20px}
.amt{font-size:12px;font-weight:700;padding:1px 7px;border-radius:9px;background:rgba(0,0,0,.45);color:#fff;line-height:16px}
.pot{display:flex;align-items:center;gap:6px}
.pot .stack{position:relative;width:20px;height:22px}
.pot .stack .chip{position:absolute;left:2px}
.pot .amt{font-size:15px;padding:2px 10px;background:rgba(0,0,0,.35);color:#ffe9a8}
.dcoin{width:20px;height:20px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#fff2b8,#e3b23c 55%,#a7791b);
 color:#3a2a06;font:800 12px/20px Arial,sans-serif;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.6)}
/* tags */
.tag{font-size:10px;line-height:14px;padding:0 5px;border-radius:7px;font-weight:700;white-space:nowrap}
.tag.sb{background:#3b6fb6;color:#fff}.tag.bb{background:#d7a531;color:#2a1d02}
.av{border-radius:50%;background:linear-gradient(160deg,#3a4a40,#1c2620);border:2px solid #d6b45a;
 display:flex;align-items:center;justify-content:center;font-family:"Noto Serif CJK TC",serif;font-weight:700;color:#f3ead2;flex:none}
/* action bar */
.bar{left:0;bottom:0;width:390px;height:78px;padding:8px 12px 24px;display:flex;gap:8px;
 background:linear-gradient(#0f1c15ee,#0b1510);border-top:1px solid rgba(214,180,90,.18)}
.btn{flex:1;height:46px;border-radius:12px;display:flex;flex-direction:column;align-items:center;justify-content:center;
 font-size:16px;font-weight:700;border:1px solid rgba(255,255,255,.08);background:#24372c;color:#f3ead2}
.btn small{font-size:11px;font-weight:400;opacity:.8;margin-top:-2px}
.btn.fold{color:#ff8d7a}.btn.raise{background:linear-gradient(#e6bf5a,#c99a2e);color:#2a1d02;border:none}
.btn.call{line-height:1.1}
"""

def card(r, s, big=False):
    red = s in "♥♦"
    return f'<div class="card{" big" if big else ""}{" red" if red else ""}"><span class="r">{r}</span><span class="s1">{s}</span><span class="s">{s}</span></div>'

BACKS = '<div class="backs"><div class="back"></div><div class="back"></div></div>'

def top():
    return '<div class="abs top" data-obj="top"><div class="t">週五牌局<small>盲注 10／20</small></div><div class="menu"><i></i><i></i><i></i></div></div>'

def bar(call="跟注", amt="20"):
    return f'''<div class="abs bar" data-obj="bar"><div class="btn fold">蓋牌</div>
<div class="btn call">{call}<small>{amt}</small></div><div class="btn raise">加注</div></div>'''

def table(l, t, w, h):
    return f'<div class="abs rail" style="left:{l}px;top:{t}px;width:{w}px;height:{h}px"><div class="felt"></div></div>'

def bet(x, y, a, cls="", name="bet"):
    return f'<div class="abs bet" data-obj="{name}" style="left:{x}px;top:{y}px"><div class="chip {cls}"></div><span class="amt">{a}</span></div>'

def pot(cx, y, a):
    return f'<div class="abs pot" data-obj="pot" style="left:{cx}px;top:{y}px;transform:translateX(-50%)"><div class="stack"><div class="chip" style="top:6px"></div><div class="chip" style="top:2px"></div></div><span class="amt">{a}</span></div>'

def dcoin(x, y):
    return f'<div class="abs dcoin" data-obj="dcoin" style="left:{x}px;top:{y}px">D</div>'

def board(cx, y, cards):
    inner = "".join(card(r, s) for r, s in cards)
    return f'<div class="abs" data-obj="board" style="left:{cx}px;top:{y}px;transform:translateX(-50%);display:flex;gap:6px">{inner}</div>'

def hero_cards(cx, y):
    return f'''<div class="abs" data-obj="hero" style="left:{cx}px;top:{y}px;transform:translateX(-50%);display:flex">
<div style="transform:rotate(-5deg);margin-right:-14px">{card("K","♥",True)}</div><div style="transform:rotate(5deg) translateY(2px)">{card("6","♦",True)}</div></div>'''

def page(body, extra_css="", check=True):
    js = PLACE + r"""<script>
window.addEventListener('load',()=>{const els=[...document.querySelectorAll('[data-obj]')];const out=[];
const R=els.map(e=>{const r=e.getBoundingClientRect();return {n:e.dataset.obj,g:e.dataset.g||e.dataset.obj,r}});
for(let i=0;i<R.length;i++){const a=R[i].r;
 if(a.left<0||a.top<0||a.right>390.5||a.bottom>844.5)out.push('CLIP '+R[i].n+' '+[a.left,a.top,a.right,a.bottom].map(Math.round));
 for(let j=i+1;j<R.length;j++){if(R[i].g===R[j].g)continue;const b=R[j].r;
  const ix=Math.min(a.right,b.right)-Math.max(a.left,b.left),iy=Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top);
  if(ix>0.5&&iy>0.5)out.push('OVERLAP '+R[i].n+' x '+R[j].n+' '+Math.round(ix)+'x'+Math.round(iy));}}
const p=document.createElement('pre');p.id='report';p.style.display='none';p.textContent='REPORT:'+(out.join(' | ')||'OK')+' GAPS:'+document.body.dataset.gaps;document.body.appendChild(p);});
</script>""" if check else ""
    return f'<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><style>{CSS}{extra_css}</style></head><body>{body}{js}</body></html>'

PLACE = r'''<script>
window.addEventListener('load',()=>{
 const GAP=10, C={x:195,y:376}, F={cx:195,cy:376,rx:168,ry:305};
 const uni=e=>{let r=e.getBoundingClientRect(),L=r.left,T=r.top,R=r.right,B=r.bottom;
   e.querySelectorAll('*').forEach(c=>{const q=c.getBoundingClientRect();if(q.width&&q.height){L=Math.min(L,q.left);T=Math.min(T,q.top);R=Math.max(R,q.right);B=Math.max(B,q.bottom);}});return {L,T,R,B};};
 const inF=(x,y)=>((x-F.cx)/F.rx)**2+((y-F.cy)/F.ry)**2<=1;
 const gapR=(a,l,t,w,h)=>Math.max(l-a.R, a.L-(l+w), t-a.B, a.T-(t+h));
 const dc=document.querySelector('.dcoin'); const D=dc?uni(dc):null;
 const bets=[...document.querySelectorAll('[data-betfor]')];
 // top seat first: its plate-centre -> chip-centre distance becomes the reference
 bets.sort((x,y)=>(y.dataset.ref?1:0)-(x.dataset.ref?1:0));
 let REF=0;
 bets.forEach(b=>{
   const seat=document.querySelector('[data-obj="'+b.dataset.betfor+'"]');
   const s=uni(seat), p=seat.querySelector('.plateA').getBoundingClientRect();
   const px=(p.left+p.right)/2, py=(p.top+p.bottom)/2;
   let ux,uy; if(b.dataset.dir){[ux,uy]=b.dataset.dir.split(',').map(Number);}else{ux=C.x-px;uy=C.y-py;}
   const n=Math.hypot(ux,uy); ux/=n; uy/=n;
   const side=Math.abs(ux)>0.9; if(side&&ux<0){b.style.flexDirection='row-reverse';}
   const w=b.offsetWidth,h=b.offsetHeight, chipOff=!side?w/2:(ux<0?w-8:8);   // measure to the chip centre
   for(let t=REF;t<400;t+=0.5){
     const cx=px+ux*t, cy=py+uy*t; const l=cx-chipOff, tp=cy-h/2;
     const g=gapR(s,l,tp,w,h), gd=D?gapR(D,l,tp,w,h):99;
     if(g>=GAP && gd>=GAP && inF(l,tp)&&inF(l+w,tp)&&inF(l,tp+h)&&inF(l+w,tp+h)){
       b.style.left=l+'px';b.style.top=tp+'px';b.dataset.gap=Math.round(g);b.dataset.dist=Math.round(t);
       if(b.dataset.ref)REF=t; break;}}
 });
 document.body.dataset.gaps=bets.map(b=>b.dataset.obj+':gap'+b.dataset.gap+'/dist'+b.dataset.dist).join(',');
});
</script>'''

def betfor(seat, a, cls="", name="bet", dir="", ref=False):
    d = f' data-dir="{dir}"' if dir else ""
    r = ' data-ref="1"' if ref else ""
    return f'<div class="abs bet" data-obj="{name}" data-betfor="{seat}"{d}{r} style="left:0;top:0"><div class="chip {cls}"></div><span class="amt">{a}</span></div>'

# ---------------- Variant A : GGPoker-like ----------------
A_CSS = """
.seatA{display:flex;flex-direction:column;align-items:center;width:108px}
.seatA .backs{margin-bottom:-6px;z-index:1}
.plateA{position:relative;width:108px;height:40px;border-radius:20px;background:rgba(10,18,14,.88);
 border:1px solid rgba(214,180,90,.45);display:flex;align-items:center;padding-left:40px;box-shadow:0 2px 8px rgba(0,0,0,.5)}
.plateA .av{position:absolute;left:3px;top:3px;width:32px;height:32px;font-size:15px}
.plateA .nm{font-size:12px;line-height:15px;display:flex;align-items:center;gap:4px;white-space:nowrap}
.plateA .st{font-size:13px;line-height:16px;font-weight:700;color:#ffd77a}
.heroA .plateA{width:auto;min-width:132px;padding-right:16px;height:44px;border-radius:22px;padding-left:46px;border-color:#d6b45a}
.heroA .plateA .av{width:36px;height:36px;font-size:16px}
"""
def seatA(x, y, name, stack, tag=None, backs=True, nm="seat"):
    t = f'<span class="tag {tag}">{"小盲" if tag=="sb" else "大盲"}</span>' if tag else ""
    b = BACKS if backs else ""
    return f'''<div class="abs seatA" data-obj="{nm}" style="left:{x}px;top:{y}px">{b}
<div class="plateA"><div class="av">{name[0]}</div><div><div class="nm">{name}{t}</div><div class="st">{stack}</div></div></div></div>'''

def heroA(cx, y):
    return f'''<div class="abs heroA" data-obj="heroplate" style="left:{cx}px;top:{y}px;transform:translateX(-50%)">
<div class="plateA"><div class="av">宗</div><div><div class="nm">宗良（你）</div><div class="st">2,000</div></div></div></div>'''

def variantA(raise_open=False):
    b = top() + table(14, 58, 362, 636)
    # s1 bottom-left 阿哲(SB), s2 top-left EMPTY, s3 top 志明(BB), s4 top-right 小芸, s5 bottom-right EMPTY; hero = dealer
    b += seatA(141, 44, "志明", "1,980", "bb", nm="s3")
    b += seatA(276, 186, "小芸", "1,980", nm="s4")
    b += seatA(6, 452, "阿哲", "1,990", "sb", nm="s1")
    b += betfor("s3", "20", name="bet3", dir="0,1", ref=True)
    b += betfor("s4", "20", name="bet4")
    b += betfor("s1", "10", "blue", name="bet1", dir="0.966,-0.259")
    b += pot(195, 340, "50")
    b += dcoin(110, 612)
    b += hero_cards(195, 586)
    b += heroA(195, 684)
    b += bar()
    css = A_CSS
    if raise_open:
        css += RAISE_CSS
        b = b.replace(bar(), "") + raise_panel()
    return page(b, css, check=True)

def variantA2():
    # 阿哲 = dealer (bottom-right s5), 宗良 = SB 10, 志明 = BB 20 (bottom-left s1), 小芸 top s3 called; s2,s4 empty
    b = top() + table(14, 58, 362, 636)
    b += seatA(141, 44, "小芸", "1,980", nm="s3")
    b += seatA(6, 452, "志明", "1,980", "bb", nm="s1")
    b += seatA(276, 452, "阿哲", "1,980", nm="s5")
    b += betfor("s3", "20", name="bet3", dir="0,1", ref=True)
    b += betfor("s1", "20", name="bet1", dir="0.966,-0.259")
    b += betfor("s5", "20", name="bet5", dir="-0.966,-0.259")
    b += pot(195, 340, "70")
    b += dcoin(300, 526)
    b += hero_cards(195, 586)
    b += '<div class="abs bet" data-obj="betH" style="left:126px;top:554px"><div class="chip blue"></div><span class="amt">10</span></div>'
    b += heroA(195, 684).replace("宗良（你）</div>", '宗良（你）<span class="tag sb">小盲</span></div>').replace("2,000", "1,990")
    b += bar("跟注", "10")
    return page(b, A_CSS, check=True)

# ---------------- Raise panel ----------------
RAISE_CSS = """
.scrim{left:0;top:0;width:390px;height:844px;background:rgba(0,0,0,.35)}
.panel{left:0;bottom:0;width:390px;padding:14px 14px 24px;background:linear-gradient(#1a2a20,#101b14);
 border-top:1px solid rgba(214,180,90,.35);border-radius:18px 18px 0 0;box-shadow:0 -10px 30px rgba(0,0,0,.5)}
.ph{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.ph b{font-size:15px}.ph span{font-size:12px;color:#c9bf9f}
.ph .big{font-size:22px;color:#ffd77a;font-weight:800;font-family:"Noto Serif CJK TC",serif}
.sl{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.rb{width:38px;height:38px;border-radius:50%;background:#24372c;border:1px solid rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:22px;color:#f3ead2}
.track{flex:1;height:6px;border-radius:3px;background:#33463a;position:relative}
.track .fill{position:absolute;left:0;top:0;height:6px;width:2%;border-radius:3px;background:#d6b45a}
.track .knob{position:absolute;left:2%;top:-9px;width:24px;height:24px;margin-left:-6px;border-radius:50%;background:#e6bf5a;border:3px solid #fff4d0;box-shadow:0 1px 4px rgba(0,0,0,.6)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;margin-bottom:12px}
.q{height:44px;border-radius:10px;background:#24372c;border:1px solid rgba(255,255,255,.08);display:flex;flex-direction:column;align-items:center;justify-content:center;font-size:13px;font-weight:700}
.q small{font-size:11px;font-weight:400;color:#c9bf9f}
.q.on{border:2px solid #d6b45a;background:#2c3f30}
.ok{height:46px;border-radius:12px;background:linear-gradient(#e6bf5a,#c99a2e);color:#2a1d02;font-size:16px;font-weight:800;display:flex;align-items:center;justify-content:center}
.rowb{display:flex;gap:8px}.rowb .cancel{width:96px;height:46px;border-radius:12px;background:#24372c;display:flex;align-items:center;justify-content:center;font-size:15px;color:#e9dfc3}
.rowb .ok{flex:1}
"""
def raise_panel():
    picks = [("最小","40"),("2.5 大盲","50"),("3 大盲","60"),("4 大盲","80"),("5 大盲","100"),("全下","2,000")]
    g = "".join(f'<div class="q{" on" if a=="60" else ""}">{n}<small>{a}</small></div>' for n,a in picks)
    return f'''<div class="abs scrim"></div><div class="abs panel" data-obj="panel">
<div class="ph"><b>加注到 <span class="big">60</span></b><span>跟注 20 · 最少加到 40</span></div>
<div class="sl"><div class="rb">−</div><div class="track"><div class="fill"></div><div class="knob"></div></div><div class="rb">＋</div></div>
<div class="grid">{g}</div>
<div class="rowb"><div class="cancel">取消</div><div class="ok">確認加注到 60</div></div></div>'''

# ---------------- Variant B : WSOP-like boxes, flop ----------------
B_CSS = """
.seatB{position:relative;width:96px;height:80px}
.seatB .av{position:absolute;left:34px;top:0;width:28px;height:28px;font-size:13px;z-index:2}
.boxB{position:absolute;left:0;top:20px;width:96px;height:42px;border-radius:8px;background:#121915;
 border:1px solid #3c4a42;text-align:center;padding-top:6px;box-shadow:0 3px 8px rgba(0,0,0,.55)}
.boxB .nm{font-size:12px;line-height:15px;color:#e9e3d2}
.boxB .st{font-size:13px;line-height:16px;font-weight:700;color:#ffd77a}
.seatB .tag{position:absolute;left:50%;transform:translateX(-50%);top:65px;z-index:2}
.seatB .backs{position:absolute;top:-2px}
.seatB.cr .backs{right:0}.seatB.cl .backs{left:0}
.heroB{width:140px;height:46px;border-radius:9px;background:#121915;border:1px solid #d6b45a;text-align:center;padding-top:5px}
.heroB .nm{font-size:13px;line-height:16px}.heroB .st{font-size:14px;line-height:18px;font-weight:700;color:#ffd77a}
"""
def seatB(x, y, name, stack, tag=None, side="cr", nm="seat"):
    t = f'<span class="tag {tag}">{"小盲" if tag=="sb" else "大盲"}</span>' if tag else ""
    return f'''<div class="abs seatB {side}" data-obj="{nm}" style="left:{x}px;top:{y}px">{BACKS}<div class="av">{name[0]}</div>
<div class="boxB"><div class="nm">{name}</div><div class="st">{stack}</div></div>{t}</div>'''

def variantB():
    b = top() + table(14, 58, 362, 636)
    b += seatB(147, 46, "志明", "1,980", "bb", "cr", "s3")
    b += seatB(282, 186, "小芸", "1,980", None, "cl", "s4")
    b += seatB(12, 452, "阿哲", "1,950", "sb", "cr", "s1")
    b += bet(118, 432, "40", name="bet1")
    b += pot(195, 292, "80")
    b += board(195, 330, [("9","♣"),("K","♠"),("4","♥")])
    b += dcoin(258, 640)
    b += hero_cards(195, 586)
    b += f'<div class="abs heroB" data-obj="heroplate" style="left:195px;top:684px;transform:translateX(-50%)"><div class="nm">宗良（你）</div><div class="st">1,980</div></div>'
    b += bar("跟注", "40")
    return page(b, B_CSS)

# ---------------- Variant C : minimal PokerStars-like ----------------
C_CSS = """
.seatC{display:flex;flex-direction:column;align-items:center}
.seatC .backs .back{width:24px;height:34px}
.plateC{margin-top:-4px;display:flex;align-items:center;gap:5px;padding:2px 9px 2px 3px;border-radius:12px;background:rgba(8,14,11,.78);white-space:nowrap}
.plateC .av{width:20px;height:20px;font-size:10px;border-width:1.5px}
.plateC .nm{font-size:11px;color:#e9e3d2}.plateC .st{font-size:12px;font-weight:700;color:#ffd77a}
.heroC{display:flex;align-items:center;gap:7px;padding:4px 14px 4px 4px;border-radius:16px;background:rgba(8,14,11,.85);border:1px solid rgba(214,180,90,.5)}
.heroC .av{width:26px;height:26px;font-size:12px}.heroC .nm{font-size:13px}.heroC .st{font-size:14px;font-weight:700;color:#ffd77a}
"""
def seatC(x, y, name, stack, tag=None, nm="seat"):
    t = f'<span class="tag {tag}">{"小盲" if tag=="sb" else "大盲"}</span>' if tag else ""
    return f'''<div class="abs seatC" data-obj="{nm}" style="left:{x}px;top:{y}px;transform:translateX(-50%)">{BACKS}
<div class="plateC"><div class="av">{name[0]}</div><span class="nm">{name}</span><span class="st">{stack}</span>{t}</div></div>'''

def variantC():
    b = top() + table(34, 92, 322, 556)
    # arc: s2 (upper-left, empty), s3 top, s4 upper-right, s1 left-lower, s5 right-lower(empty)
    b += seatC(195, 58, "志明", "1,980", "bb", "s3")
    b += seatC(318, 168, "小芸", "1,980", None, "s4")
    b += seatC(72, 362, "阿哲", "1,990", "sb", "s1")
    b += bet(176, 144, "20", name="bet3")
    b += bet(228, 238, "20", name="bet4")
    b += bet(112, 440, "10", "blue", name="bet1")
    b += pot(195, 330, "50")
    b += dcoin(112, 610)
    b += hero_cards(195, 598)
    b += f'<div class="abs heroC" data-obj="heroplate" style="left:195px;top:700px;transform:translateX(-50%)"><div class="av">宗</div><span class="nm">宗良（你）</span><span class="st">2,000</span></div>'
    b += bar()
    return page(b, C_CSS)

pages = {"A2": variantA2(), "A": variantA(), "A-raise": variantA(True), "B": variantB(), "C": variantC()}
for k, v in pages.items():
    open(os.path.join(OUT, k + ".html"), "w").write(v)
print("ok")
