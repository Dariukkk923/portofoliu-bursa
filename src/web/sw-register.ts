/** Înregistrează service worker-ul și anunță când există o versiune nouă (aplicată doar la cererea utilizatorului). */
export function registerServiceWorker(onUpdate: (apply: () => void) => void): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const base = import.meta.env.BASE_URL;
  // La prima instalare noul worker preia controlul fără reîncărcare; reîncărcăm doar la o actualizare.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker
    .register(`${base}sw.js`, { scope: base })
    .then((reg) => {
      const announce = (sw: ServiceWorker): void => onUpdate(() => sw.postMessage('skip-waiting'));
      if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        sw?.addEventListener('statechange', () => {
          if (sw.state === 'installed' && navigator.serviceWorker.controller) announce(sw);
        });
      });
      // O aplicație instalată rămâne deschisă zile întregi: verificăm de fiecare dată când revine în prim-plan.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => undefined);
      });
    })
    .catch(() => undefined);
}
