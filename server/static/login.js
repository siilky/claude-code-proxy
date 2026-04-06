document.getElementById('authButton').addEventListener('click', async function(e) {
  e.preventDefault();

  var response = await fetch('/auth/get-url');
  var data = await response.json();

  if (data.url) {
    window.open(data.url, '_blank');
  }
});

// Show error from callback redirect (?error=...)
(function() {
  var params = new URLSearchParams(window.location.search);
  var error = params.get('error');
  if (!error) return;

  var banner = document.getElementById('errorBanner');
  if (banner) {
    banner.textContent = error;
    banner.style.display = 'block';
  }

  // Clean URL without reloading
  history.replaceState(null, '', window.location.pathname);
})();
