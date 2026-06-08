/* Carga y guarda la config en chrome.storage.local. connector.js reacciona al
   cambio (chrome.storage.onChanged) y reconecta sin recargar la pestaña. */
const $ = (id) => document.getElementById(id);

chrome.storage.local.get(['gatewayUrl', 'sellerId', 'token'], (r) => {
  $('gatewayUrl').value = r.gatewayUrl || '';
  $('sellerId').value = r.sellerId || '';
  $('token').value = r.token || '';
});

$('save').addEventListener('click', () => {
  const gatewayUrl = $('gatewayUrl').value.trim();
  const sellerId = $('sellerId').value.trim();
  const token = $('token').value.trim();
  if (!gatewayUrl || !sellerId || !token) {
    $('status').textContent = 'Completá los tres campos.';
    $('status').style.color = '#dc2626';
    return;
  }
  chrome.storage.local.set({ gatewayUrl, sellerId, token }, () => {
    $('status').style.color = '#16a34a';
    $('status').textContent = '✓ Guardado. La pestaña de WhatsApp Web se conectará en unos segundos.';
  });
});
