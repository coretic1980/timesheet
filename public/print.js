// Afdrukknop op het factuurdocument (los bestand vanwege de Content-Security-Policy).
document.querySelector('[data-print]')?.addEventListener('click', () => window.print());
