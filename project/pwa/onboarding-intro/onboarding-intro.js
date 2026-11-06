(function(global){
  'use strict';
  const MOTION=Object.freeze({hold:850,slide:650,mediaDelay:1500,mediaFade:550,actionsDelay:1800,actionsFade:400,easing:'cubic-bezier(0.22,1,0.36,1)'});
  class NimaOnboardingIntro{
    constructor(root){
      this.root=root;this.video=root.querySelector('video');this.media=root.querySelector('.nima-intro__media');
      this.logo=root.querySelector('.nima-intro__logo');this.mark=this.logo.querySelector('img');
      this.actions=root.querySelector('.nima-intro__actions');this.toggle=root.querySelector('.nima-intro__motion')||document.createElement('button');// optional: the app ships no pause control, so a detached stand-in keeps the logic unchanged
      this.preference=matchMedia('(prefers-reduced-motion: reduce)');this.animations=[];this.run=0;this.disposed=false;
      this.onPreference=()=>this.replay();
      this.onVisibility=()=>{
        if(document.hidden){this.video.pause();this.animations.forEach(a=>{if(a.playState==='running')a.pause()});}
        else{this.animations.forEach(a=>{if(a.playState==='paused')a.play()});if(this.mediaEnabled&&!this.userPaused)this.play();}
      };
      this.onPlaying=()=>{
        const run=this.run;
        const ready=()=>{if(!this.disposed&&run===this.run)this.root.dataset.videoReady='true';};
        if(this.video.requestVideoFrameCallback)this.video.requestVideoFrameCallback(ready);else ready();
      };
      this.onError=()=>{this.root.dataset.videoReady='false';this.video.pause();this.toggle.hidden=true;};
      this.onToggle=()=>{
        this.userPaused=!this.userPaused;
        if(this.userPaused)this.video.pause();else this.play();
        this.toggle.textContent=this.userPaused?'▶':'Ⅱ';this.toggle.setAttribute('aria-label',this.userPaused?'Play background video':'Pause background video');
      };
      this.video.addEventListener('playing',this.onPlaying);this.video.addEventListener('error',this.onError);
      this.toggle.addEventListener('click',this.onToggle);this.preference.addEventListener('change',this.onPreference);
      document.addEventListener('visibilitychange',this.onVisibility);this.replay();
    }
    play(){
      if(this.disposed||this.preference.matches||document.hidden||this.userPaused)return;
      this.video.muted=true;this.video.defaultMuted=true;
      this.video.play().catch(()=>{if(!this.disposed){this.root.dataset.videoReady='false';this.toggle.hidden=true;}});
    }
    replay(){
      if(this.disposed)return;
      const run=++this.run;clearTimeout(this.playTimer);this.animations.forEach(a=>a.cancel());this.animations=[];
      this.video.pause();this.video.removeAttribute('src');this.video.load();this.root.dataset.videoReady='false';
      this.userPaused=false;this.mediaEnabled=false;this.actions.inert=false;this.toggle.hidden=true;
      this.toggle.textContent='Ⅱ';this.toggle.setAttribute('aria-label','Pause background video');
      // Final CSS state is the fallback when motion or the animation API is unavailable.
      if(this.preference.matches||!this.logo.animate)return;
      const animate=(element,frames,options)=>{const a=element.animate(frames,{fill:'both',...options});this.animations.push(a);return a;};
      animate(this.logo,[{transform:'translate3d(0,0,0)'},{transform:'translate3d(0,-34%,0)'}],{delay:MOTION.hold,duration:MOTION.slide,easing:MOTION.easing});
      animate(this.mark,[{transform:'scale(1.15)'},{transform:'scale(1)'}],{delay:MOTION.hold,duration:MOTION.slide,easing:MOTION.easing});
      animate(this.media,[{opacity:0},{opacity:1}],{delay:MOTION.mediaDelay,duration:MOTION.mediaFade,easing:'ease-out'});
      this.actions.inert=true;
      const actions=animate(this.actions,[{opacity:0,transform:'translate3d(0,14px,0)'},{opacity:1,transform:'translate3d(0,0,0)'}],{delay:MOTION.actionsDelay,duration:MOTION.actionsFade,easing:MOTION.easing});
      actions.finished.then(()=>{if(!this.disposed&&this.run===run)this.actions.inert=false;}).catch(()=>{});
      const motion=animate(this.toggle,[{opacity:0},{opacity:1}],{delay:MOTION.actionsDelay,duration:MOTION.actionsFade});
      this.toggle.hidden=false;
      this.video.preload='auto';this.video.muted=true;this.video.defaultMuted=true;this.video.loop=true;this.video.playsInline=true;
      this.video.src=this.video.dataset.src;this.video.load();
      this.playTimer=setTimeout(()=>{if(this.run===run){this.mediaEnabled=true;this.play();}},MOTION.mediaDelay);
      if(document.hidden)this.animations.forEach(a=>a.pause());
    }
    destroy(){
      if(this.disposed)return;this.disposed=true;this.run++;clearTimeout(this.playTimer);
      this.animations.forEach(a=>a.cancel());this.actions.inert=false;this.video.pause();this.video.removeAttribute('src');this.video.load();
      this.video.removeEventListener('playing',this.onPlaying);this.video.removeEventListener('error',this.onError);
      this.toggle.removeEventListener('click',this.onToggle);this.preference.removeEventListener('change',this.onPreference);
      document.removeEventListener('visibilitychange',this.onVisibility);
    }
  }
  NimaOnboardingIntro.MOTION=MOTION;global.NimaOnboardingIntro=NimaOnboardingIntro;
})(window);
