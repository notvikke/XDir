document.addEventListener('DOMContentLoaded', () => {
    fetch('http://127.0.0.1:8765/api/stats')
        .then(res => res.json())
        .then(stats => {
            document.getElementById('dot').className = 'dot';
            document.getElementById('status-text').textContent = 'App Connected';
            document.getElementById('val-total').textContent = stats.total;
            document.getElementById('val-updates').textContent = stats.updates;
        })
        .catch(() => {
            document.getElementById('dot').className = 'dot offline';
            document.getElementById('status-text').textContent = 'App Offline';
        });

    document.getElementById('btn-sync').addEventListener('click', () => {
        chrome.tabs.create({ url: 'http://127.0.0.1:8765/' });
    });
});
