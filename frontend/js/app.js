// Rileva automaticamente se siamo in locale o produzione
const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const API = isLocal ? 'http://localhost:8787/api' : '/api'; // In prod si assume che il frontend sia servito dallo stesso dominio o configurato via proxy
let currentId = null, cart = [], allCats = [], allProducts = [], activeCatFilter = 'TUTTI', charts = {}, currentReceipts = [];
const COLORS = ['#2563eb', '#10b981', '#f59e0b', '#e11d48', '#8b5cf6', '#06b6d4', '#f43f5e', '#ec4899'];

// Wrapper per chiamate API autenticate
async function apiCall(endpoint, method = 'GET', body = null) {
    const token = localStorage.getItem('ezToken');
    const headers = { 'Content-Type': 'application/json' };
    if(token) headers['Authorization'] = `Bearer ${token}`;
    
    const res = await fetch(`${API}${endpoint}`, { method, headers, body: body ? JSON.stringify(body) : null });
    if(res.status === 401) { doLogout(); return null; }
    return res;
}

function navigate(id) {
    document.querySelectorAll('#app > div').forEach(d => d.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
}

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    document.getElementById('tab-'+tab).classList.add('active');
    document.getElementById('sub-'+tab).classList.remove('hidden');
    if(tab === 'repo') loadReports(); 
    else if(tab === 'cassa') {
        if(document.getElementById('sub-tab-hist').classList.contains('active')) loadHistory();
        else refresh();
    }
    else refresh();
}

function switchCassaMode(mode) {
    document.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('sub-tab-'+mode).classList.add('active');
    document.getElementById('cassa-view-pos').classList.add('hidden');
    document.getElementById('cassa-view-hist').classList.add('hidden');
    document.getElementById('cassa-view-'+mode).classList.remove('hidden');
    if(mode === 'hist') loadHistory(); else refresh();
}

// --- POS & CORE (Invariati) ---
function filterPos(cat) { activeCatFilter = cat; renderPosCategories(); renderPosProducts(); }
function renderPosCategories() {
    const cats = ['TUTTI', ...allCats.map(c => c.nome)];
    document.getElementById('pos-cat-bar').innerHTML = cats.map(c => `<div class="cat-pill ${activeCatFilter === c ? 'active' : ''}" onclick="filterPos('${c}')">${c.toUpperCase()}</div>`).join('');
}
function renderPosProducts() {
    const filtered = activeCatFilter === 'TUTTI' ? allProducts : allProducts.filter(p => p.categoria === activeCatFilter);
    document.getElementById('pos-products').innerHTML = filtered.map(p => {
        const qty = cart.filter(i => i._id === p._id).length;
        const badge = qty > 0 ? `<div style="position:absolute; top:-8px; right:-8px; background:var(--d); color:white; border-radius:50%; width:24px; height:24px; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:bold; box-shadow:0 2px 4px rgba(0,0,0,0.2); z-index:2">${qty}</div>` : '';
        return `<div class="product-card" style="position:relative; overflow:visible" onclick='addToCart(${JSON.stringify(p)})'>${badge}<small>${p.categoria}</small><br><strong>${p.nome}</strong><br><b style="color:var(--p)">${parseFloat(p.prezzo).toFixed(2)}€</b></div>`;
    }).join('');
}
function addToCart(p) { cart.push({...p}); renderCart(); }
function renderCart() {
    renderPosProducts(); // Aggiorna i badge quantità
    document.getElementById('cart-list').innerHTML = cart.map((item, i) => `<div class="cart-item"><span>${item.nome}</span><span>${parseFloat(item.prezzo).toFixed(2)}€ <button onclick="cart.splice(${i},1);renderCart()" style="background:none;color:red;padding:0;cursor:pointer">✕</button></span></div>`).join('');
    const total = cart.reduce((sum, item) => sum + parseFloat(item.prezzo), 0);
    document.getElementById('cart-sum').innerText = total.toFixed(2);
    if(document.getElementById('cart-preview-total')) document.getElementById('cart-preview-total').innerText = total.toFixed(2) + '€';
    if(document.getElementById('cart-count-badge')) document.getElementById('cart-count-badge').innerText = `(${cart.length})`;
}
async function processSale() {
    if(!cart.length) return showToast("Il carrello è vuoto", "error");
    // Security Fix: Ricalcola il totale dai dati grezzi, non dal DOM
    const calculatedTotal = cart.reduce((sum, item) => sum + parseFloat(item.prezzo), 0).toFixed(2);
    await apiCall(`/vendite?companyId=${currentId}`, 'POST', { items: cart, total: calculatedTotal, date: new Date() });
    showToast("Scontrino Chiuso!", "success"); cart = []; renderCart(); toggleCart();
}

// --- STORICO SCONTRINI ---
async function loadHistory() {
    const dateInput = document.getElementById('histDate');
    if(!dateInput.value) {
        const now = new Date();
        dateInput.value = new Date(now.getTime() - (now.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    }
    
    try {
        const res = await apiCall(`/vendite?companyId=${currentId}&date=${dateInput.value}`);
        if(!res) return;
        
        if(!res.ok) throw new Error(`Errore API (${res.status})`);
        
        let receipts = await res.json();
        if(!Array.isArray(receipts)) throw new Error("Formato dati non valido");
        
        // Filtro Client-side e Ordinamento Decrescente (Newest First)
        const filterDate = dateInput.value;
        receipts = receipts.filter(r => {
            const d = new Date(r.date || r.createdAt);
            if(isNaN(d.getTime())) return false;
            const localYMD = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
            return localYMD === filterDate;
        }).sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0));
        
        currentReceipts = receipts; // Salva in memoria per i dettagli
        
        const tbody = document.querySelector('#tHistory tbody');
        if(!receipts.length) { tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:20px">Nessuno scontrino trovato</td></tr>'; return; }
        
        let dayTotal = 0;
        tbody.innerHTML = receipts.map(r => {
            dayTotal += parseFloat(r.total);
            const d = new Date(r.date || r.createdAt);
            const time = !isNaN(d) ? d.toLocaleTimeString('it-IT', {hour:'2-digit', minute:'2-digit'}) : '-';
            const formattedTotal = parseFloat(r.total).toFixed(2);
            return `<tr id="row-hist-${r._id}">
                <td>${time}</td>
                <td>${formattedTotal}€</td>
                <td style="text-align:right">
                    <button class="btn-grey" style="padding:5px 8px; background:#3b82f6" onclick="showReceiptDetails('${r._id}')">ℹ️</button>
                </td>
            </tr>`;
        }).join('') + `<tr style="background:#f1f5f9; font-weight:bold; border-top:2px solid #cbd5e1"><td>TOTALE</td><td>${dayTotal.toFixed(2)}€</td><td></td></tr>`;
    } catch (e) {
        console.error(e);
        showToast("Errore caricamento: " + e.message, "error");
        document.querySelector('#tHistory tbody').innerHTML = `<tr><td colspan="3" style="text-align:center; color:red; padding:20px">Errore connessione server</td></tr>`;
    }
}

function showReceiptDetails(id) {
    const r = currentReceipts.find(x => x._id === id);
    if(!r || !r.items || !r.items.length) return showToast("Nessun dettaglio prodotti", "neutral");
    const list = r.items.map(i => `- ${i.nome}: ${parseFloat(i.prezzo).toFixed(2)}€`).join('\n');
    alert(`Dettaglio Scontrino:\n\n${list}`);
}

// --- REPORT CON ORDINAMENTO CRONOLOGICO COMPLETO ---
async function loadReports() {
    if(!allCats.length) await refresh(); // Assicura che le categorie siano caricate per i filtri
    
    if(document.getElementById('repSelC').innerHTML === "") {
        const cNames = allCats.map(c => c.nome);
        document.getElementById('repSelC').innerHTML = '<option value="TUTTI">Tutte le categorie</option>' + cNames.map(n => `<option value="${n}">${n}</option>`).join('');
        updateProductFilter(false); // Pass false to skip auto-apply
    }
    await applyReports();
}

function updateProductFilter(apply = true) {
    const selC = document.getElementById('repSelC').value;
    const filteredProducts = selC === 'TUTTI' ? allProducts : allProducts.filter(p => p.categoria === selC);
    const pNames = [...new Set(filteredProducts.map(p => p.nome))];
    document.getElementById('repSelP').innerHTML = '<option value="TUTTI">Tutti i prodotti</option>' + pNames.map(n => `<option value="${n}">${n}</option>`).join('');
    if(apply) applyReports();
}

function setRange(mode) {
    const to = new Date(); let from = new Date();
    if(mode === '7d') from.setDate(to.getDate() - 7);
    else if(mode === '1m') from.setMonth(to.getMonth() - 1);
    else if(mode === '3m') from.setMonth(to.getMonth() - 3);
    else if(mode === 'today') from = new Date();
    document.getElementById('repFrom').value = from.toISOString().split('T')[0];
    document.getElementById('repTo').value = to.toISOString().split('T')[0];
    applyReports();
}

async function applyReports() {
    const from = document.getElementById('repFrom').value, to = document.getElementById('repTo').value, 
          selC = document.getElementById('repSelC').value, selP = document.getElementById('repSelP').value;
    
    const query = new URLSearchParams({ companyId: currentId, category: selC, product: selP });
    if(from) query.append('from', from);
    if(to) query.append('to', to);

    const res = await apiCall(`/reports?${query.toString()}`);
    const data = await res.json();

    // Mapping Dati Backend -> UI
    const totalRevenue = data.totals[0] ? data.totals[0].totalRevenue : 0;
    const totalReceipts = data.receiptsCount[0] ? data.receiptsCount[0].count : 0;
    const topProd = data.topProducts[0];

    document.getElementById('stat-total').innerText = totalRevenue.toFixed(2) + "€";
    document.getElementById('stat-count').innerText = totalReceipts;
    document.getElementById('stat-top').innerText = topProd ? `${topProd._id} (${topProd.q} pz)` : "-";

    // Trend Chart
    const allDates = data.trend.map(t => t._id);
    const trendLabels = allDates.map(d => new Date(d).toLocaleDateString('it-IT', {day:'2-digit', month:'short'}));
    let trendDatasets = [];

    if (selC !== 'TUTTI' && selP === 'TUTTI') {
        const products = [...new Set(data.trendBreakdown.map(t => t._id.p))];
        products.forEach((pName, idx) => {
            const pData = allDates.map(d => {
                const item = data.trendBreakdown.find(x => x._id.d === d && x._id.p === pName);
                return item ? item.dailyTotal : 0;
            });
            trendDatasets.push({
                label: pName,
                data: pData,
                borderColor: COLORS[idx % COLORS.length],
                backgroundColor: COLORS[idx % COLORS.length] + '22',
                fill: false, tension: 0.4
            });
        });
    } else {
        trendDatasets.push({
            label: selP === 'TUTTI' ? 'Fatturato Totale' : selP,
            data: data.trend.map(t => t.dailyTotal),
            borderColor: COLORS[0],
            backgroundColor: COLORS[0] + '22',
            fill: true, tension: 0.4
        });
    }
    
    updateMultiChart('chartTrend', 'line', trendLabels, trendDatasets);

    // Hourly Chart
    const hours = Array(24).fill(0);
    data.hourly.forEach(h => hours[h._id] = h.count);
    updateChart('chartHour', 'bar', Array.from({length:24},(_,i)=>i+":00"), hours, 'Attività', '#10b981');

    // Category/Product Distribution Chart
    const catLabels = data.byCategory.map(c => c._id);
    const catData = data.byCategory.map(c => c.total);
    updateChart('chartCat', 'doughnut', catLabels, catData, 'Distribuzione');

    // Top Products Table
    document.querySelector('#tTopProds tbody').innerHTML = data.topProducts.map(p => `<tr><td>${p._id}</td><td>${p.q}</td><td>${p.t.toFixed(2)}€</td></tr>`).join('');
}

function updateMultiChart(id, type, labels, datasets) {
    if(charts[id]) charts[id].destroy();
    charts[id] = new Chart(document.getElementById(id), {
        type, data: { labels, datasets },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: true, position: 'top', labels: { usePointStyle: true, boxWidth: 6, font:{family:'Inter'} } } }, scales: { y: { beginAtZero: true, grid: { color: '#f1f5f9' } }, x: { grid: { display: false } } } }
    });
}

function updateChart(id, type, labels, data, label, color = '#2563eb') {
    if(charts[id]) charts[id].destroy();
    const ctx = document.getElementById(id).getContext('2d');
    let background = color;
    if (type === 'bar') {
        const g = ctx.createLinearGradient(0, 0, 0, 250); g.addColorStop(0, color + 'cc'); g.addColorStop(1, color + '22'); background = g;
    } else if (type === 'doughnut') { background = COLORS; }
    charts[id] = new Chart(ctx, {
        type, data: { labels, datasets: [{ label, data, backgroundColor: background, borderColor: type === 'doughnut' ? '#fff' : color, borderWidth: 1, borderRadius: 5 }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: type === 'doughnut', position: 'bottom' } }, scales: type === 'doughnut' ? {} : { y: { beginAtZero: true }, x: { grid: { display: false } } } }
    });
}

// --- REFRESH & LOGIN ---
async function refresh() {
    if(!currentId) return;
    const [rc, rp] = await Promise.all([apiCall(`/categorie?companyId=${currentId}`), apiCall(`/prodotti?companyId=${currentId}`)]);
    allCats = await rc.json(); allProducts = await rp.json();
    document.getElementById('tCats').innerHTML = allCats.map(c => `<tr id="row-cat-${c._id}"><td>${c.nome}</td><td style="text-align:right"><button class="btn-edit" onclick="editCatRow('${c._id}','${c.nome}')">✏️</button> <button class="btn-red" style="padding:5px 8px" onclick="delItem('categorie','${c._id}')">🗑️</button></td></tr>`).join('');
    document.getElementById('selPC').innerHTML = allCats.map(c => `<option value="${c.nome}">${c.nome}</option>`).join('');
    document.getElementById('tProds').innerHTML = allProducts.map(p => `<tr id="row-prod-${p._id}"><td><strong>${p.nome}</strong><br><small>${p.categoria}</small></td><td>${p.prezzo}€</td><td style="text-align:right"><button class="btn-edit" onclick="editProdRow('${p._id}','${p.nome}',${p.prezzo},'${p.categoria}')">✏️</button> <button class="btn-red" style="padding:5px 8px" onclick="delItem('prodotti','${p._id}')">🗑️</button></td></tr>`).join('');
    renderPosCategories(); renderPosProducts();
}

function toggleAuthMode() {
    document.getElementById('form-login').classList.toggle('hidden');
    document.getElementById('form-register').classList.toggle('hidden');
}

async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim(); 
    const pass = document.getElementById('loginPass').value.trim();
    if(!email || !pass) return showToast("Inserisci email e password", "error");
    
    const btn = document.getElementById('btnLogin');
    btn.disabled = true; btn.innerText = "Accesso...";
    
    try {
        const res = await fetch(`${API}/login`, { method: 'POST', body: JSON.stringify({email, password: pass}) });
        const d = await res.json(); 
        if(d.success) { 
            localStorage.setItem('ezUser', JSON.stringify(d.user)); 
            localStorage.setItem('ezToken', d.token); 
            showSelection(); 
        } else {
            showToast(d.message || "Credenziali errate", "error");
        }
    } catch(e) { showToast("Errore di connessione", "error"); }
    finally { btn.disabled = false; btn.innerText = "Accedi"; }
}
async function doRegister() {
    const nome = document.getElementById('regNome').value.trim();
    const cognome = document.getElementById('regCognome').value.trim();
    const dob = document.getElementById('regDob').value;
    const email = document.getElementById('regEmail').value.trim();
    const pass = document.getElementById('regPass').value.trim();

    if(!nome || !cognome || !dob || !email || !pass) return showToast("Compila tutti i campi", "error");

    const btn = document.getElementById('btnReg');
    btn.disabled = true; btn.innerText = "Attendere...";

    try {
        const res = await fetch(`${API}/register`, { method: 'POST', body: JSON.stringify({nome, cognome, dob, email, password: pass}) });
        const d = await res.json();
        if(d.success) { 
            showToast("Registrato! Ora accedi.", "success"); 
            toggleAuthMode(); // Torna al login
        } else {
            showToast(d.message || "Errore registrazione", "error");
        }
    } catch(e) { showToast("Errore di connessione", "error"); }
    finally { btn.disabled = false; btn.innerText = "Registrati"; }
}
async function showSelection() {
    const user = JSON.parse(localStorage.getItem('ezUser'));
    if(!user) return navigate('view-login'); navigate('view-selection');
    const res = await apiCall(`/user/companies`); // Username preso dal token backend
    const cos = await res.json();
    document.getElementById('list-companies').innerHTML = cos.map(c => `<button class="btn-grey" onclick="openDash('${c._id}','${c.name}','${c.inviteCode}')">${c.name}</button>`).join(' ');
}
function openDash(id, name, code) { currentId = id; document.getElementById('activeCoName').innerText = name; document.getElementById('activeCoCode').innerText = "Cod: "+code; navigate('view-dashboard'); switchTab('cassa'); }

// Toast Logic
function showToast(msg, type = 'neutral') {
    const c = document.getElementById('toast-container');
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.innerHTML = type === 'success' ? '✅ '+msg : (type === 'error' ? '⚠️ '+msg : msg);
    c.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}

async function addCat() { await apiCall(`/categorie?companyId=${currentId}`, 'POST', {nome: inCat.value}); inCat.value = ""; refresh(); showToast('Categoria aggiunta', 'success'); }
async function addProd() { await apiCall(`/prodotti?companyId=${currentId}`, 'POST', {nome: inPN.value, prezzo: inPP.value, categoria: selPC.value}); inPN.value = ""; inPP.value = ""; refresh(); showToast('Prodotto aggiunto', 'success'); }
async function delItem(t, id) { if(confirm("Eliminare?")) { await apiCall(`/${t}?id=${id}&companyId=${currentId}`, 'DELETE'); refresh(); showToast('Elemento eliminato'); } }

function editCatRow(id, name) {
    const row = document.getElementById(`row-cat-${id}`);
    row.innerHTML = `<td><input id="e-cn-${id}" value="${name}"></td><td style="text-align:right"><button class="btn-save" onclick="saveCat('${id}')">💾</button> <button class="btn-grey" onclick="refresh()">❌</button></td>`;
}
async function saveCat(id) {
    await apiCall(`/categorie?id=${id}&companyId=${currentId}`, 'PUT', {nome: document.getElementById(`e-cn-${id}`).value}); refresh(); showToast('Categoria modificata', 'success');
}
function editProdRow(id, name, price, cat) {
    const row = document.getElementById(`row-prod-${id}`);
    const opts = allCats.map(c => `<option value="${c.nome}" ${c.nome===cat?'selected':''}>${c.nome}</option>`).join('');
    row.innerHTML = `<td><input id="e-pn-${id}" value="${name}" style="margin-bottom:5px"><select id="e-pc-${id}">${opts}</select></td><td><input id="e-pp-${id}" value="${price}" type="number" style="width:70px">€</td><td style="text-align:right"><button class="btn-save" onclick="saveProd('${id}')">💾</button> <button class="btn-grey" onclick="refresh()">❌</button></td>`;
}
async function saveProd(id) {
    await apiCall(`/prodotti?id=${id}&companyId=${currentId}`, 'PUT', {nome: document.getElementById(`e-pn-${id}`).value, prezzo: document.getElementById(`e-pp-${id}`).value, categoria: document.getElementById(`e-pc-${id}`).value}); refresh(); showToast('Prodotto salvato', 'success');
}

async function doCreateCo() { await apiCall(`/azienda/crea`, 'POST', {companyName: newCo.value}); newCo.value = ""; showSelection(); }
async function doJoinCo() { const res = await apiCall(`/azienda/unisciti`, 'POST', {inviteCode: joinCode.value}); if(res && res.ok) { joinCode.value = ""; showSelection(); } else showToast("Codice invito errato", "error"); }
function doLogout() { localStorage.clear(); location.reload(); }
if(localStorage.getItem('ezUser')) showSelection();

// Mobile Cart Toggle
function toggleCart() {
    document.getElementById('mobile-cart').classList.toggle('open');
}

function toggleReportFilters() {
    const body = document.getElementById('report-filters-body');
    const icon = document.querySelector('.filter-toggle-icon');
    if(window.innerWidth <= 768) { body.classList.toggle('open'); icon.classList.toggle('open'); }
}

// PWA Service Worker Registration
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').then(reg => console.log('SW registered', reg)).catch(err => console.log('SW failed', err));
    });
}