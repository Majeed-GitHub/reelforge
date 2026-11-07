/**
 * Reelforge marketing site — progressive enhancement only.
 * If this file fails to load, the page still reads and scrolls correctly.
 */
(() => {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- sticky nav state --------------------------------------------------- */
  const nav = document.querySelector('[data-nav]');
  if (nav) {
    const onScroll = () => nav.classList.toggle('is-scrolled', window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });

    const toggle = nav.querySelector('[data-nav-toggle]');
    toggle?.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open');
      toggle.setAttribute('aria-expanded', String(open));
    });
    nav.querySelectorAll('.nav-links a').forEach((link) =>
      link.addEventListener('click', () => {
        nav.classList.remove('is-open');
        toggle?.setAttribute('aria-expanded', 'false');
      })
    );
  }

  /* --- scroll reveal ------------------------------------------------------ */
  const revealables = Array.from(document.querySelectorAll('[data-reveal]'));
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          // Stagger siblings slightly so groups feel composed, not robotic.
          const siblings = entry.target.parentElement
            ? Array.from(entry.target.parentElement.children).indexOf(entry.target)
            : 0;
          entry.target.style.transitionDelay = `${Math.min(siblings, 5) * 60}ms`;
          entry.target.classList.add('is-in');
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.12 }
    );
    revealables.forEach((el) => observer.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add('is-in'));
  }

  /* --- hero video: play only when visible --------------------------------- */
  const video = document.querySelector('.hero-video');
  if (video) {
    if (reduceMotion) {
      video.removeAttribute('autoplay');
      video.addEventListener('mouseenter', () => video.play().catch(() => {}));
    } else if ('IntersectionObserver' in window) {
      const playObserver = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            if (entry.isIntersecting) video.play().catch(() => {});
            else video.pause();
          });
        },
        { threshold: 0.35 }
      );
      playObserver.observe(video);
    }
    // If the promo file is not there yet, fall back to the poster silently.
    video.addEventListener('error', () => {
      video.style.display = 'none';
      const frame = video.parentElement;
      if (frame && !frame.querySelector('.hero-fallback')) {
        const img = document.createElement('img');
        img.className = 'hero-fallback';
        img.src = 'assets/img/video-poster.png';
        img.alt = 'Reelforge pipeline: one instruction becomes a video, article, walkthrough and guide';
        img.style.borderRadius = '6px';
        img.style.border = '1px solid rgba(255,255,255,0.09)';
        frame.prepend(img);
      }
    });
  }

  /* --- provider marquee: duplicate the track for a seamless loop ---------- */
  const track = document.querySelector('[data-marquee]');
  if (track && !reduceMotion) {
    track.innerHTML += track.innerHTML;
  }

  /* --- copy buttons ------------------------------------------------------- */
  document.querySelectorAll('[data-copy]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.getAttribute('target') || '');
      const text = target ? target.innerText.trim() : '';
      const original = button.textContent;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      window.setTimeout(() => {
        button.textContent = original;
      }, 1600);
    });
  });

  /* --- footer year -------------------------------------------------------- */
  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();
