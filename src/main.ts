import "./style.css";

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <section class="card">
    <div class="mark">ID</div>
    <h1>InstaDesk</h1>
    <p>Instagram opens in its own app window. Use the tray icon to open DMs or change notification settings.</p>
    <p class="muted">Unofficial wrapper. Not affiliated with Instagram or Meta.</p>
  </section>`;
