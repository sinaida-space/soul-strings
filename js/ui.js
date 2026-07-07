// SOUL_STRINGS — UI chrome module
// Owns: page chrome DOM wiring, state classes, overlays.
// Never imports other modules; dispatches CustomEvents on window.

const $ = (sel) => document.querySelector(sel);

function dispatch(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

const UI = {
  init() {
    const initiate = $('#initiate');
    const noCam = $('#no-cam');
    const scaleToggle = $('#scale-toggle');
    const recBtn = $('#rec-btn');
    const closeModal = $('#close-modal');
    const shareBtn = $('#share-btn');

    if (initiate) {
      initiate.addEventListener('click', () => {
        dispatch('soul:start');
      });
    }

    if (noCam) {
      noCam.addEventListener('click', () => {
        dispatch('soul:fallback');
      });
    }

    if (scaleToggle) {
      scaleToggle.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-scale]');
        if (!btn) return;
        scaleToggle.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        dispatch('soul:scale', btn.dataset.scale);
      });
    }

    if (recBtn) {
      recBtn.addEventListener('click', () => {
        dispatch('soul:rec-toggle');
      });
    }

    if (closeModal) {
      closeModal.addEventListener('click', () => {
        UI.hideShareModal();
      });
    }

    if (shareBtn) {
      shareBtn.addEventListener('click', () => {
        dispatch('soul:share');
      });
    }
  },

  setState(s) {
    document.body.dataset.state = s;
  },

  setRec(on, seconds) {
    const recBtn = $('#rec-btn');
    if (!recBtn) return;
    recBtn.classList.toggle('recording', !!on);
    if (on) {
      const secs = typeof seconds === 'number' ? String(seconds).padStart(2, '0') : '00';
      recBtn.textContent = `● ${secs}`;
    } else {
      recBtn.textContent = '● REC';
    }
  },

  showShareModal(objectUrl) {
    const modal = $('#share-modal');
    const video = modal ? modal.querySelector('video') : null;
    const downloadLink = $('#download-link');
    if (video) video.src = objectUrl;
    if (downloadLink) downloadLink.href = objectUrl;
    if (modal) modal.hidden = false;
  },

  hideShareModal() {
    const modal = $('#share-modal');
    if (modal) modal.hidden = true;
  },

  setHint(text) {
    const hint = $('#hint');
    if (hint) hint.textContent = text || '';
  },
};

export { UI };
