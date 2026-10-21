// Umami custom events (Umami → Events), on top of its page views: which jobs are opened, viewed and applied to,
// which companies are filtered and what people search. track(name, data) is safe when Umami is blocked or still
// loading (its script is deferred): it waits for the page's load event, then sends once if Umami is there.
// Umami limits: event names up to 50 characters, text values up to 500.
window.track = (name, data = {}) => {
  const clean = Object.fromEntries(Object.entries(data)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v]));
  const send = () => { try { window.umami?.track(name, clean); } catch { /* analytics never breaks the page */ } };
  if (window.umami || document.readyState === 'complete') send();
  else addEventListener('load', send, { once: true });
};
