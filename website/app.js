const app = document.querySelector("#app");

const state = {
  user: null,
  identities: [],
  users: [],
  csrfToken: "",
  authMode: "login",
  croppedPhotos: {},
  photoEditStates: {},
  standardCropZoom: null,
  editingPhotosFor: null,
  transferringIdentityFor: null
};

const govScreenAssets = {
  wallet: "/assets/gov-screens/wallet-list.jpg",
  front: "/assets/gov-screens/document-front.jpg",
  back: "/assets/gov-screens/document-back.jpg",
  signature: "/assets/gov-screens/document-signature.jpg",
  qr: "/assets/gov-screens/document-qr.jpg?v=2"
};

const cropTemplateAssets = {
  number7: "/assets/templates/template-do-numero-7.png?v=1",
  number0: "/assets/templates/template-do-numero-0.png?v=2"
};

const documentPages = [
  govScreenAssets.front,
  govScreenAssets.back,
  govScreenAssets.signature,
  govScreenAssets.qr
];

const documentPhotoSteps = [
  { key: "front", label: "Frente" },
  { key: "back", label: "Verso" },
  { key: "signature", label: "Assinatura" },
  { key: "qr", label: "QR padrao" }
];

const requiredDocumentUploadSteps = documentPhotoSteps.slice(0, 3);
const documentUploadSteps = documentPhotoSteps;

const acceptedPhotoTypes = "image/jpeg,image/png,image/webp,image/heic,image/heif,image/gif,image/bmp";
const maxPhotoSizeBytes = 4 * 1024 * 1024;
const documentCrop = {
  width: 999,
  height: 1512,
  aspectRatio: 333 / 504,
  current: null
};
const cropEraseBackground = "#f7f5e9";
const cropPencilColor = "#e7e7c3";
const cropEraseFillColor = cropPencilColor;

const referenceView = {
  mode: "wallet",
  pageIndex: 0,
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  touchStartX: 0,
  touchStartY: 0,
  panStartX: 0,
  panStartY: 0,
  pinchStartCenterX: 0,
  pinchStartCenterY: 0,
  pinchStartOffsetX: 0,
  pinchStartOffsetY: 0,
  pinchStartDistance: 0,
  pinchStartZoom: 1,
  wheelSlideLock: false
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function govLogo() {
  return `
    <span class="gov-logo" aria-label="gov.br">
      <span>g</span><span>o</span><span>v</span><span>.</span><span>b</span><span>r</span>
    </span>
  `;
}

function navSvg(name) {
  const paths = {
    home: `<path d="M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z" />`,
    data: `<path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1S9.6 1.84 9.18 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm0 4c1.66 0 3 1.34 3 3s-1.34 3-3 3-3-1.34-3-3 1.34-3 3-3zm6 12H6v-1.4c0-2 4-3.1 6-3.1s6 1.1 6 3.1V19z" />`,
    qr: `<path d="M3 3h8v8H3V3zm2 2v4h4V5H5zm8-2h8v8h-8V3zm2 2v4h4V5h-4zM3 13h8v8H3v-8zm2 2v4h4v-4H5zm10-2h2v2h-2v-2zm-2 0h2v4h-2v-4zm4 2h4v2h-4v-2zm2 2h2v4h-2v-4zm-6 2h2v2h-2v-2zm2-2h2v2h-2v-2z" />`,
    wallet: `<path d="M21 7H5c-1.1 0-2-.9-2-2s.9-2 2-2h14v2H5v.1c0 .5.4.9.9.9H21c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2V7.8c.6.2 1.3.2 2 .2h16v2h-4c-1.7 0-3 1.3-3 3s1.3 3 3 3h4v2H5V8h16V7zm-4 5c-.6 0-1 .4-1 1s.4 1 1 1h4v-2h-4z" />`,
    menu: `<path d="M4 7h16v2H4V7zm0 4h16v2H4v-2zm0 4h16v2H4v-2z" />`
  };

  return `<svg class="nav-svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name]}</svg>`;
}

async function api(path, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (!["GET", "HEAD", "OPTIONS"].includes(method) && state.csrfToken) {
    headers["X-CSRF-Token"] = state.csrfToken;
  }

  const response = await fetch(path, {
    ...options,
    headers
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Falha na requisicao");
  }
  return payload;
}

function goTo(path, replace = false) {
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  renderRoute();
}

async function ensureUser() {
  if (state.user) return true;

  try {
    const payload = await api("/api/me");
    state.user = payload.user;
    state.csrfToken = payload.csrfToken || "";
    return true;
  } catch {
    state.csrfToken = "";
    return false;
  }
}

async function loadIdentities() {
  const payload = await api("/api/identities");
  state.identities = payload.identities || [];
}

async function loadUsers() {
  if (!isAdmin()) {
    state.users = [];
    return;
  }

  const payload = await api("/api/users");
  state.users = payload.users || [];
}

function isAdmin() {
  return state.user && state.user.role === "admin";
}

function renderShell(content) {
  app.innerHTML = content;
  bindEvents();
}

function setModalScrollLock(isLocked) {
  document.body.classList.toggle("has-modal-open", Boolean(isLocked));
}

function renderAuthPage(message = "") {
  const isLogin = state.authMode === "login";

  renderShell(`
    <section class="auth-page">
      <div class="auth-card">
        <div class="auth-brand">
          ${govLogo()}
          <span>Gov.Fake</span>
        </div>

        <div class="auth-copy">
          <span class="eyebrow">Acesso seguro</span>
          <h1>${isLogin ? "Entre com usuario." : "Crie seu usuario."}</h1>
          <p>Use seu usuario para cadastrar, consultar e remover identidades no painel.</p>
        </div>

        <div class="auth-tabs" role="tablist">
          <button class="${isLogin ? "active" : ""}" type="button" data-auth-mode="login">Login</button>
          <button class="${!isLogin ? "active" : ""}" type="button" data-auth-mode="register">Cadastro</button>
        </div>

        <form class="auth-form" id="authForm">
          ${!isLogin ? `
            <label>
              <span>Usuario</span>
              <input name="username" type="text" autocomplete="username" placeholder="seu.usuario" required />
            </label>
          ` : `
            <label>
              <span>Usuario</span>
              <input name="login" type="text" autocomplete="username" placeholder="seu.usuario" required />
            </label>
          `}
          <label>
            <span>Senha</span>
            <input name="password" type="password" autocomplete="${isLogin ? "current-password" : "new-password"}" placeholder="Minimo de 6 caracteres" required />
          </label>
          ${message ? `<p class="form-message">${escapeHtml(message)}</p>` : ""}
          <button class="primary-btn" type="submit">${isLogin ? "Entrar" : "Cadastrar"}</button>
        </form>
      </div>

      <aside class="auth-preview" aria-label="Tela Gov.Fake">
        <div class="canva-screen">
          <div class="canva-mark">
            <span>Gov</span><span>.</span><span>Fake</span>
          </div>
          <p class="canva-credit">SaaS developed by lacerda</p>
          <div class="canva-ribbon"></div>
        </div>
      </aside>
    </section>
  `);
}

function identityCard(identity) {
  const hasRequiredPhotos = identity.photoSlides && identity.photoSlides.length >= requiredDocumentUploadSteps.length;
  const hasCustomQr = identity.photoSlides && identity.photoSlides.length >= documentPhotoSteps.length;

  return `
    <article class="identity-card">
      <div>
        <span class="identity-chip">ID</span>
        <h3>${escapeHtml(identity.title)}</h3>
        <small>${hasRequiredPhotos ? `3 fotos + ${hasCustomQr ? "QR editado" : "QR padrao"}` : "Sem fotos anexadas"}</small>
        ${isAdmin() ? `<em>@${escapeHtml(identity.ownerUsername || identity.ownerName || "usuario")}</em>` : ""}
      </div>
      <div class="identity-actions">
        <button class="secondary-btn" type="button" data-open-identity="${escapeHtml(identity.id)}">Acessar</button>
        <button class="secondary-btn" type="button" data-rename-identity="${escapeHtml(identity.id)}">Renomear</button>
        <button class="secondary-btn" type="button" data-edit-identity-photos="${escapeHtml(identity.id)}">Editar fotos</button>
        ${isAdmin() ? `<button class="secondary-btn" type="button" data-transfer-identity="${escapeHtml(identity.id)}">Transferir</button>` : ""}
        <button class="danger-btn" type="button" data-remove-identity="${escapeHtml(identity.id)}">Remover</button>
      </div>
    </article>
  `;
}

function adminUserList() {
  if (!isAdmin()) return "";

  return `
    <section class="admin-users">
      <div class="panel-heading compact">
        <div>
          <span class="eyebrow">Usuarios</span>
          <h2>Gerenciar usuarios</h2>
        </div>
        <strong>${state.users.length}</strong>
      </div>
      <div class="user-list">
        ${state.users.length
          ? state.users.map((user) => {
            const identityCount = state.identities.filter((identity) => identity.userId === user.id).length;
            const isCurrentUser = user.id === state.user.id;
            return `
              <article class="user-card">
                <div>
                  <strong>@${escapeHtml(user.username || user.name)}</strong>
                  <small>${escapeHtml(user.role || "user")} - ${identityCount} identidade${identityCount === 1 ? "" : "s"}</small>
                </div>
                <button class="danger-btn" type="button" data-remove-user="${escapeHtml(user.id)}" ${isCurrentUser ? "disabled" : ""}>Remover</button>
              </article>
            `;
          }).join("")
          : `<div class="empty-state compact">Nenhum usuario cadastrado.</div>`}
      </div>
    </section>
  `;
}

async function renderDashboardPage() {
  const hasUser = await ensureUser();
  if (!hasUser) {
    goTo("/auth", true);
    return;
  }

  await loadIdentities();
  await loadUsers();
  state.croppedPhotos = {};
  state.photoEditStates = {};
  state.standardCropZoom = null;

  renderShell(`
    <section class="dashboard-page">
      <header class="dashboard-header">
        <div>
          ${govLogo()}
          <h1>Dashboard</h1>
          ${isAdmin() ? "" : "<p>Gerencie as identidades vinculadas ao seu usuario.</p>"}
        </div>
        <div class="header-actions">
          <span>@${escapeHtml(state.user.username || state.user.name)}${isAdmin() ? " - admin" : ""}</span>
          <button class="ghost-btn" id="logoutButton" type="button">Sair</button>
        </div>
      </header>

      <main class="dashboard-grid">
        <section class="panel identities-panel">
          <div class="panel-heading">
            <div>
              <span class="eyebrow">Carteira</span>
              <h2>${isAdmin() ? "Todas as identidades" : "Suas identidades"}</h2>
            </div>
            <strong>${state.identities.length}</strong>
          </div>

          <div class="identity-list">
            ${state.identities.length
              ? state.identities.map(identityCard).join("")
              : `<div class="empty-state">Nenhuma identidade cadastrada ainda.</div>`}
          </div>
        </section>

        <aside class="panel create-panel">
          ${adminUserList()}
          <span class="eyebrow">Nova identidade</span>
          <h2>Criar identidade</h2>
          <form id="identityForm" class="identity-form">
            ${isAdmin() ? `
              <label>
                <span>Usuario dono</span>
                <select name="userId" required>
                  ${state.users.map((user) => `
                    <option value="${escapeHtml(user.id)}">@${escapeHtml(user.username || user.name)}</option>
                  `).join("")}
                </select>
              </label>
            ` : ""}
            <label>
              <span>Titulo</span>
              <input name="title" type="text" placeholder="Identidade 2" />
            </label>
            <div class="wallet-data-card">
              <p class="form-note">Dados exibidos no card azul da carteira.</p>
              <label>
                <span>Nome exibido</span>
                <input name="displayName" type="text" placeholder="NOME COMPLETO" required />
              </label>
              <label>
                <span>CPF</span>
                <input name="cpf" type="text" placeholder="000.000.000-00" required />
              </label>
            </div>
            <div class="ordered-uploads" aria-label="Fotos da identidade em ordem">
              <p class="form-note">Anexe as 3 fotos obrigatorias: Frente, Verso e Assinatura. O QR padrao entra automaticamente no quarto slide; envie uma quarta imagem apenas se quiser ajustar as bordas.</p>
              ${documentUploadSteps.map((step, index) => `
                <label class="upload-step">
                  <span>${index + 1}. ${step.label}${index < requiredDocumentUploadSteps.length ? "" : " (opcional)"}</span>
                  <input name="${step.key}" type="file" accept="${acceptedPhotoTypes}" ${index < requiredDocumentUploadSteps.length ? "required" : ""} />
                  <small class="crop-status ${index < requiredDocumentUploadSteps.length ? "" : "ready"}" data-crop-status="${step.key}" aria-live="polite">${index < requiredDocumentUploadSteps.length ? `Recorte pendente - ${documentCrop.width}x${documentCrop.height}` : "QR padrao sera usado se nenhum arquivo for enviado."}</small>
                </label>
              `).join("")}
            </div>
            <div class="form-actions">
              <button class="primary-btn" type="submit">Criar</button>
            </div>
          </form>
        </aside>
      </main>
      <div class="photo-edit-modal" id="photoEditModal" hidden>
        <form class="photo-edit-dialog" id="photoEditForm">
          <div class="crop-header">
            <div>
              <span class="eyebrow">Editar identidade</span>
              <h2>Editar fotos</h2>
              <p>Edite as fotos atuais ou substitua somente as que desejar.</p>
            </div>
            <button class="crop-icon-btn" type="button" id="photoEditClose" aria-label="Fechar">x</button>
          </div>
          <div class="ordered-uploads" aria-label="Fotos da identidade para editar">
            ${documentUploadSteps.map((step, index) => `
              <div class="upload-step">
                <label>
                  <span>${index + 1}. ${step.label}${index < requiredDocumentUploadSteps.length ? "" : " (opcional)"}</span>
                  <input name="edit-${step.key}" type="file" accept="${acceptedPhotoTypes}" />
                  <small class="crop-status ready" data-edit-crop-status="${step.key}" aria-live="polite">${index < requiredDocumentUploadSteps.length ? `Foto atual mantida - ${documentCrop.width}x${documentCrop.height}` : "QR padrao mantido se nenhum arquivo for enviado."}</small>
                </label>
                <button class="secondary-btn edit-current-photo-btn" type="button" data-edit-current-photo="${step.key}">Editar foto atual</button>
              </div>
            `).join("")}
          </div>
          <div class="crop-footer">
            <button class="ghost-btn" type="button" id="photoEditCancel">Cancelar</button>
            <button class="primary-btn" type="submit">Salvar fotos</button>
          </div>
        </form>
      </div>
      <div class="transfer-identity-modal" id="transferIdentityModal" hidden>
        <form class="transfer-identity-dialog" id="transferIdentityForm">
          <div class="crop-header">
            <div>
              <span class="eyebrow">Transferir identidade</span>
              <h2 id="transferIdentityTitle">Transferir</h2>
              <p id="transferIdentityDescription">A identidade sera movida da conta atual para o usuario selecionado.</p>
            </div>
            <button class="crop-icon-btn" type="button" id="transferIdentityClose" aria-label="Fechar">x</button>
          </div>
          <label>
            <span>Usuario destino</span>
            <select name="targetUserId" id="transferIdentityTarget" required></select>
          </label>
          <div class="crop-footer">
            <button class="ghost-btn" type="button" id="transferIdentityCancel">Cancelar</button>
            <button class="primary-btn" type="submit">Confirmar transferencia</button>
          </div>
        </form>
      </div>
      <div class="crop-modal" id="cropModal" hidden>
        <div class="crop-dialog" role="dialog" aria-modal="true" aria-labelledby="cropTitle">
          <div class="crop-header">
            <div>
              <span class="eyebrow">Recorte do documento</span>
              <h2 id="cropTitle">Ajuste a imagem</h2>
              <p>Formato final: ${documentCrop.width}x${documentCrop.height}. Esse recorte preenche a area central da identidade.</p>
            </div>
            <button class="crop-icon-btn" type="button" id="cropCancel" aria-label="Fechar">x</button>
          </div>
          <div class="crop-stage-wrap">
            <canvas id="cropCanvas" width="333" height="504" aria-label="Previa do recorte"></canvas>
          </div>
          <div class="crop-controls">
            <label>
              <span>Zoom</span>
              <input id="cropZoom" type="range" min="0.1" max="6" step="0.01" value="1" />
            </label>
            <div class="crop-actions-row">
              <button class="secondary-btn" type="button" id="cropRotateLeft">Girar esquerda</button>
              <button class="secondary-btn" type="button" id="cropRotateRight">Girar direita</button>
            </div>
            <div class="front-edit-tools" id="frontEditTools" hidden>
              <div class="crop-tool-tabs" aria-label="Ferramentas de edicao">
                <button class="active" type="button" data-crop-mode="move">Mover</button>
                <button type="button" data-crop-mode="erase">Borracha</button>
                <button type="button" data-crop-mode="pencil">Lapis</button>
                <button type="button" data-crop-mode="sticker7">Numero 7</button>
                <button type="button" data-crop-mode="sticker0">Numero 0</button>
              </div>
              <button class="secondary-btn undo-brush-btn" type="button" id="undoBrushStroke" disabled>Desfazer</button>
              <label>
                <span>Tamanho da borracha</span>
                <input id="eraserSize" type="range" min="1" max="120" step="1" value="18" />
              </label>
              <label>
                <span>Tamanho do lapis</span>
                <input id="pencilSize" type="range" min="1" max="120" step="1" value="18" />
              </label>
              <div class="crop-actions-row">
                <button class="secondary-btn" type="button" id="addNumberSticker">Adicionar 7</button>
                <button class="secondary-btn" type="button" id="addNumberZeroSticker">Adicionar 0</button>
              </div>
              <label>
                <span>Tamanho do adesivo</span>
                <input id="stickerSize" type="range" min="40" max="360" step="1" value="150" />
              </label>
            </div>
            <p class="form-note">Arraste a imagem dentro do quadro para centralizar antes de aplicar.</p>
          </div>
          <div class="crop-footer">
            <button class="ghost-btn" type="button" id="cropCancelFooter">Cancelar</button>
            <button class="primary-btn" type="button" id="cropApply">Aplicar recorte</button>
          </div>
        </div>
      </div>
    </section>
  `);
}

function renderIdentityView(identity) {
  const slides = getIdentityDocumentPages(identity);
  const displayName = identity.displayName || "MARIA CAROLINA DE AZEREDO MELO";
  const cpf = identity.cpf || "053.374.621-30";
  renderShell(`
    <section class="fake-id-page">
      <div class="identity-phone" id="identityPhone" aria-label="Carteira de documentos">
        <div class="wallet-shell" id="walletHome">
          <header class="wallet-brandbar">
            ${govLogo()}
            <span class="wallet-avatar" aria-hidden="true"></span>
          </header>

          <div class="wallet-titlebar">
            <button class="wallet-back-button" id="backDashboard" type="button" aria-label="Voltar ao dashboard"></button>
            <h1>Carteira de documentos</h1>
          </div>

          <main class="wallet-content">
            <button class="gov-wallet-card" id="openReferenceDoc" type="button" aria-label="Abrir identidade">
              <span class="gov-wallet-corner">ID</span>
              <strong>Carteira de Identidade</strong>
              <p>${escapeHtml(displayName)}</p>
              <span class="gov-wallet-label">CPF</span>
              <small>${escapeHtml(cpf)}</small>
            </button>
          </main>

          <button class="wallet-add-button" id="addFromIdentity" type="button">Adicionar documento</button>

          <nav class="wallet-bottom-nav" aria-label="Navegacao principal">
            <span>${navSvg("home")}<em>Inicio</em></span>
            <span>${navSvg("data")}<em>Dados</em></span>
            <strong><span class="qr-nav-circle">${navSvg("qr")}</span><em>QR Code</em></strong>
            <span class="active">${navSvg("wallet")}<em>Carteira</em></span>
            <span>${navSvg("menu")}<em>Menu</em></span>
          </nav>
        </div>

        <div class="document-topbar" id="documentTopbar" hidden>
          <div class="document-topbar-main">
            ${govLogo()}
            <button class="document-close-btn" id="documentCloseDashboard" type="button" aria-label="Voltar ao dashboard">x</button>
          </div>
        </div>
        <div class="document-view" id="documentView" hidden>
          <div class="reference-stage" id="referenceStage">
            <img class="reference-image" id="referenceImage" src="${slides[0]}" alt="Documento - Frente" />
          </div>
        </div>
        <div class="document-controls" id="documentControls" hidden>
          <button class="document-zoom-btn" id="toggleDocumentZoom" type="button" aria-label="Alternar zoom">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10.5 4a6.5 6.5 0 0 1 5.16 10.45l3.45 3.44-1.42 1.42-3.44-3.45A6.5 6.5 0 1 1 10.5 4Zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm1 2v1.5H13V11h-1.5v1.5H10V11H8.5V9.5H10V8h1.5Z" />
            </svg>
          </button>
          <button class="document-inline-btn" id="prevReferenceDoc" type="button" aria-label="Documento anterior">‹</button>
          <div class="document-dots" id="documentDots" aria-label="Pagina atual"></div>
          <button class="document-inline-btn" id="nextReferenceDoc" type="button" aria-label="Proximo documento">›</button>
          <button class="document-menu-btn" type="button" aria-label="Menu do documento">⋮</button>
        </div>
      </div>
    </section>
  `);
  setupReferenceIdentityView(slides);
}

function getIdentityDocumentPages(identity) {
  if (identity && Array.isArray(identity.photoSlides) && identity.photoSlides.length >= requiredDocumentUploadSteps.length) {
    return [
      identity.photoSlides[0],
      identity.photoSlides[1],
      identity.photoSlides[2],
      identity.photoSlides[3] || govScreenAssets.qr
    ];
  }

  return documentPages;
}

function openPhotoEditModal(identityId) {
  const identity = state.identities.find((item) => item.id === identityId);
  const modal = document.querySelector("#photoEditModal");
  const form = document.querySelector("#photoEditForm");
  if (!identity || !modal || !form) return;

  state.editingPhotosFor = identityId;
  state.croppedPhotos = {};
  state.photoEditStates = {};
  state.standardCropZoom = null;
  documentUploadSteps.forEach((step, index) => {
    state.croppedPhotos[step.key] = identity.photoSlides && identity.photoSlides[index] ? identity.photoSlides[index] : "";
    const savedEdit = identity.photoEditStates && identity.photoEditStates[step.key];
    state.photoEditStates[step.key] = clonePhotoEditState(savedEdit) || (state.croppedPhotos[step.key]
      ? createLegacyPhotoEditState(state.croppedPhotos[step.key])
      : null);
    const input = form.querySelector(`input[name="edit-${step.key}"]`);
    const status = form.querySelector(`[data-edit-crop-status="${step.key}"]`);
    const editButton = form.querySelector(`[data-edit-current-photo="${step.key}"]`);
    if (input) input.value = "";
    if (editButton) editButton.disabled = !(state.photoEditStates[step.key] && state.photoEditStates[step.key].source);
    if (status) {
      status.textContent = state.croppedPhotos[step.key]
        ? `${step.key === "qr" ? "QR editado mantido" : "Foto atual mantida"} - ${documentCrop.width}x${documentCrop.height}`
        : step.key === "qr"
          ? "QR padrao mantido se nenhum arquivo for enviado."
          : `Recorte pendente - ${documentCrop.width}x${documentCrop.height}`;
      status.classList.toggle("ready", Boolean(state.croppedPhotos[step.key]));
    }
  });
  modal.hidden = false;
  setModalScrollLock(true);
  modal.querySelector("input, button, select")?.focus();
}

function closePhotoEditModal() {
  const modal = document.querySelector("#photoEditModal");
  const form = document.querySelector("#photoEditForm");
  if (modal) modal.hidden = true;
  if (form) form.reset();
  setModalScrollLock(false);
  state.editingPhotosFor = null;
  state.croppedPhotos = {};
  state.photoEditStates = {};
  state.standardCropZoom = null;
}

function openTransferIdentityModal(identityId) {
  const identity = state.identities.find((item) => item.id === identityId);
  const modal = document.querySelector("#transferIdentityModal");
  const form = document.querySelector("#transferIdentityForm");
  const title = document.querySelector("#transferIdentityTitle");
  const description = document.querySelector("#transferIdentityDescription");
  const targetSelect = document.querySelector("#transferIdentityTarget");
  if (!identity || !modal || !form || !targetSelect) return;

  const users = state.users.filter((user) => user.id !== identity.userId);
  state.transferringIdentityFor = identityId;
  if (title) title.textContent = `Transferir ${identity.title}`;
  if (description) {
    const currentOwner = identity.ownerUsername || identity.ownerName || "usuario atual";
    description.textContent = `A identidade sera movida de @${currentOwner} para o usuario selecionado.`;
  }
  targetSelect.innerHTML = users.length
    ? users.map((user) => `
      <option value="${escapeHtml(user.id)}">@${escapeHtml(user.username || user.name)}</option>
    `).join("")
    : `<option value="">Nenhum outro usuario disponivel</option>`;
  targetSelect.disabled = users.length === 0;
  const submitButton = form.querySelector('button[type="submit"]');
  if (submitButton) submitButton.disabled = users.length === 0;
  modal.hidden = false;
  setModalScrollLock(true);
  modal.querySelector("select, button")?.focus();
}

function closeTransferIdentityModal() {
  const modal = document.querySelector("#transferIdentityModal");
  const form = document.querySelector("#transferIdentityForm");
  if (modal) modal.hidden = true;
  if (form) form.reset();
  setModalScrollLock(false);
  state.transferringIdentityFor = null;
}

function setupReferenceIdentityView(slides = documentPages) {
  referenceView.mode = "wallet";
  referenceView.pageIndex = 0;
  referenceView.documentPages = slides;
  resetReferenceZoom();

  const image = document.querySelector("#referenceImage");
  const stage = document.querySelector("#referenceStage");
  const openButton = document.querySelector("#openReferenceDoc");
  const prevButton = document.querySelector("#prevReferenceDoc");
  const nextButton = document.querySelector("#nextReferenceDoc");
  const zoomButton = document.querySelector("#toggleDocumentZoom");

  openButton.addEventListener("click", openReferenceDocument);
  prevButton.addEventListener("click", () => changeReferencePage(referenceView.pageIndex - 1));
  nextButton.addEventListener("click", () => changeReferencePage(referenceView.pageIndex + 1));
  zoomButton.addEventListener("click", toggleReferenceZoom);

  stage.addEventListener("touchstart", handleReferenceTouchStart, { passive: false });
  stage.addEventListener("touchmove", handleReferenceTouchMove, { passive: false });
  stage.addEventListener("touchend", handleReferenceTouchEnd);
  stage.addEventListener("touchcancel", handleReferenceTouchCancel);
  stage.addEventListener("wheel", handleReferenceWheel, { passive: false });
}

function openReferenceDocument() {
  referenceView.mode = "doc";
  referenceView.pageIndex = 0;
  resetReferenceZoom();
  const phone = document.querySelector("#identityPhone");
  const documentView = document.querySelector("#documentView");
  const documentControls = document.querySelector("#documentControls");
  const documentTopbar = document.querySelector("#documentTopbar");
  if (phone) phone.classList.add("is-document-open");
  if (documentView) documentView.hidden = false;
  if (documentControls) documentControls.hidden = false;
  if (documentTopbar) documentTopbar.hidden = false;
  renderReferenceDocumentPage();
}

function renderReferenceDocumentPage() {
  const image = document.querySelector("#referenceImage");
  const openButton = document.querySelector("#openReferenceDoc");
  const prevButton = document.querySelector("#prevReferenceDoc");
  const nextButton = document.querySelector("#nextReferenceDoc");
  const dots = document.querySelector("#documentDots");

  image.hidden = false;
  image.src = referenceView.documentPages[referenceView.pageIndex];
  image.alt = documentPhotoSteps[referenceView.pageIndex]
    ? `Documento - ${documentPhotoSteps[referenceView.pageIndex].label}`
    : `Documento pagina ${referenceView.pageIndex + 1}`;
  document.querySelector("#referenceStage").classList.add("can-pinch");
  openButton.hidden = true;
  prevButton.disabled = referenceView.pageIndex === 0;
  nextButton.disabled = referenceView.pageIndex === referenceView.documentPages.length - 1;
  if (dots) {
    dots.innerHTML = referenceView.documentPages.map((_, index) => `
      <span class="${index === referenceView.pageIndex ? "active" : ""}" aria-hidden="true"></span>
    `).join("");
  }
  applyReferenceZoom();
}

function toggleReferenceZoom() {
  if (referenceView.mode !== "doc") return;
  const stage = document.querySelector("#referenceStage");
  const rect = stage ? stage.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
  const anchor = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2
  };
  setReferenceZoomAt(anchor, referenceView.zoom > 1.01 ? 1 : 2);
  applyReferenceZoom();
}

function changeReferencePage(nextIndex) {
  if (referenceView.mode !== "doc") return;
  if (nextIndex < 0 || nextIndex >= referenceView.documentPages.length || nextIndex === referenceView.pageIndex) return false;
  referenceView.pageIndex = nextIndex;
  resetReferenceZoom();
  renderReferenceDocumentPage();
  return true;
}

function resetReferenceZoom() {
  referenceView.zoom = 1;
  referenceView.offsetX = 0;
  referenceView.offsetY = 0;
  referenceView.pinchStartDistance = 0;
  applyReferenceZoom();
}

function applyReferenceZoom() {
  const stage = document.querySelector("#referenceStage");
  if (!stage) return;
  constrainReferencePan();
  stage.style.setProperty("--doc-zoom", referenceView.zoom.toFixed(3));
  stage.style.setProperty("--doc-pan-x", `${referenceView.offsetX.toFixed(1)}px`);
  stage.style.setProperty("--doc-pan-y", `${referenceView.offsetY.toFixed(1)}px`);
  stage.classList.toggle("is-zoomed", referenceView.zoom > 1.01);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function touchCenter(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

function setReferenceZoomAt(anchor, nextZoom) {
  const metrics = getReferenceStageMetrics();
  if (!metrics) return;
  const currentZoom = referenceView.zoom || 1;
  const zoom = clamp(nextZoom, 1, 4);
  const localX = anchor.x - metrics.originX;
  const localY = anchor.y - metrics.originY;
  const contentX = (localX - referenceView.offsetX) / currentZoom;
  const contentY = (localY - referenceView.offsetY) / currentZoom;
  referenceView.zoom = zoom;
  referenceView.offsetX = localX - contentX * zoom;
  referenceView.offsetY = localY - contentY * zoom;
  constrainReferencePan();
}

function getReferenceStageMetrics() {
  const stage = document.querySelector("#referenceStage");
  if (!stage) return null;
  const zoom = referenceView.zoom || 1;
  const rect = stage.getBoundingClientRect();
  return {
    originX: rect.left - referenceView.offsetX,
    originY: rect.top - referenceView.offsetY,
    width: rect.width / zoom,
    height: rect.height / zoom
  };
}

function constrainReferencePan() {
  const metrics = getReferenceStageMetrics();
  if (!metrics || referenceView.zoom <= 1.01) {
    referenceView.offsetX = 0;
    referenceView.offsetY = 0;
    return;
  }

  const minX = -metrics.width * (referenceView.zoom - 1);
  const minY = -metrics.height * (referenceView.zoom - 1);
  referenceView.offsetX = clamp(referenceView.offsetX, minX, 0);
  referenceView.offsetY = clamp(referenceView.offsetY, minY, 0);
}

function handleReferenceTouchStart(event) {
  if (referenceView.mode !== "doc") return;

  if (event.touches.length === 2) {
    event.preventDefault();
    const center = touchCenter(event.touches);
    referenceView.pinchStartDistance = touchDistance(event.touches);
    referenceView.pinchStartZoom = referenceView.zoom;
    referenceView.pinchStartCenterX = center.x;
    referenceView.pinchStartCenterY = center.y;
    referenceView.pinchStartOffsetX = referenceView.offsetX;
    referenceView.pinchStartOffsetY = referenceView.offsetY;
    return;
  }

  if (event.touches.length !== 1) return;
  const touch = event.touches[0];
  referenceView.touchStartX = touch.clientX;
  referenceView.touchStartY = touch.clientY;
  referenceView.panStartX = referenceView.offsetX;
  referenceView.panStartY = referenceView.offsetY;
  referenceView.swipeHandled = false;
}

function handleReferenceTouchMove(event) {
  if (referenceView.mode !== "doc") return;

  if (event.touches.length === 2 && referenceView.pinchStartDistance > 0) {
    event.preventDefault();
    const metrics = getReferenceStageMetrics();
    if (!metrics) return;
    const center = touchCenter(event.touches);
    const distance = touchDistance(event.touches);
    const nextZoom = clamp(referenceView.pinchStartZoom * (distance / referenceView.pinchStartDistance), 1, 4);
    const currentLocalX = center.x - metrics.originX;
    const currentLocalY = center.y - metrics.originY;
    const startLocalX = referenceView.pinchStartCenterX - metrics.originX;
    const startLocalY = referenceView.pinchStartCenterY - metrics.originY;
    const contentX = (startLocalX - referenceView.pinchStartOffsetX) / referenceView.pinchStartZoom;
    const contentY = (startLocalY - referenceView.pinchStartOffsetY) / referenceView.pinchStartZoom;
    referenceView.zoom = nextZoom;
    referenceView.offsetX = currentLocalX - contentX * nextZoom;
    referenceView.offsetY = currentLocalY - contentY * nextZoom;
    applyReferenceZoom();
    return;
  }

  if (event.touches.length === 1 && referenceView.zoom <= 1.01 && !referenceView.swipeHandled) {
    const touch = event.touches[0];
    const dx = touch.clientX - referenceView.touchStartX;
    const dy = touch.clientY - referenceView.touchStartY;
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.15) {
      event.preventDefault();
      if (Math.abs(dx) > 54) {
        referenceView.swipeHandled = changeReferencePage(referenceView.pageIndex + (dx < 0 ? 1 : -1));
      }
    }
    return;
  }

  if (event.touches.length === 1 && referenceView.zoom > 1.01) {
    event.preventDefault();
    const touch = event.touches[0];
    referenceView.offsetX = referenceView.panStartX + touch.clientX - referenceView.touchStartX;
    referenceView.offsetY = referenceView.panStartY + touch.clientY - referenceView.touchStartY;
    applyReferenceZoom();
  }
}

function handleReferenceTouchEnd(event) {
  if (referenceView.mode !== "doc") return;
  if (event.touches.length < 2) {
    referenceView.pinchStartDistance = 0;
  }
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    referenceView.touchStartX = touch.clientX;
    referenceView.touchStartY = touch.clientY;
    referenceView.panStartX = referenceView.offsetX;
    referenceView.panStartY = referenceView.offsetY;
    return;
  }
  if (event.touches.length > 0 || referenceView.zoom > 1.01) return;
  if (referenceView.swipeHandled) {
    referenceView.swipeHandled = false;
    return;
  }

  const touch = event.changedTouches[0];
  const dx = touch.clientX - referenceView.touchStartX;
  const dy = touch.clientY - referenceView.touchStartY;
  if (Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
  changeReferencePage(referenceView.pageIndex + (dx < 0 ? 1 : -1));
}

function handleReferenceTouchCancel() {
  referenceView.pinchStartDistance = 0;
  referenceView.swipeHandled = false;
}

function handleReferenceWheel(event) {
  if (referenceView.mode !== "doc") return;
  if (Math.abs(event.deltaX) < 28 || Math.abs(event.deltaX) < Math.abs(event.deltaY) * 1.15 || referenceView.wheelSlideLock) {
    return;
  }

  event.preventDefault();
  referenceView.wheelSlideLock = true;
  changeReferencePage(referenceView.pageIndex + (event.deltaX > 0 ? 1 : -1));
  window.setTimeout(() => {
    referenceView.wheelSlideLock = false;
  }, 420);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("Nao foi possivel ler a foto.")));
    reader.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image));
    image.addEventListener("error", () => reject(new Error("Nao foi possivel abrir a imagem.")));
    image.src = src;
  });
}

function createLegacyPhotoEditState(source) {
  return {
    source,
    rotation: 0,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    eraserSize: 18,
    pencilSize: 18,
    sticker: null,
    brushHistory: []
  };
}

function clonePhotoEditState(edit) {
  if (!edit) return null;
  return JSON.parse(JSON.stringify(edit));
}

function resetCropState() {
  if (documentCrop.current && documentCrop.current.renderFrame) {
    cancelAnimationFrame(documentCrop.current.renderFrame);
  }
  documentCrop.current = null;
}

async function openCropper(stepKey, file = null, statusElement = null, savedEdit = null) {
  let source = savedEdit && savedEdit.source;
  if (file instanceof File && file.name) {
    if (!acceptedPhotoTypes.split(",").includes(file.type)) {
      throw new Error("A imagem deve ser JPG, PNG, WEBP, HEIC, HEIF, GIF ou BMP.");
    }
    if (file.size > maxPhotoSizeBytes) {
      throw new Error("A imagem deve ter no maximo 4 MB.");
    }
    source = await readFileAsDataUrl(file);
    savedEdit = null;
  }
  if (!source) return;

  const image = await loadImage(source);
  const canvas = document.querySelector("#cropCanvas");
  const zoomInput = document.querySelector("#cropZoom");
  const modal = document.querySelector("#cropModal");
  const title = document.querySelector("#cropTitle");
  const step = documentPhotoSteps.find((item) => item.key === stepKey);
  const isFront = stepKey === "front";
  const eraseCanvas = isFront ? document.createElement("canvas") : null;
  const eraseFillCanvas = isFront ? document.createElement("canvas") : null;
  const paintCanvas = isFront ? document.createElement("canvas") : null;
  const templateImages = isFront
    ? {
      number7: await loadImage(cropTemplateAssets.number7),
      number0: await loadImage(cropTemplateAssets.number0)
    }
    : {};

  if (eraseCanvas) {
    eraseCanvas.width = image.naturalWidth;
    eraseCanvas.height = image.naturalHeight;
  }
  if (eraseFillCanvas) {
    eraseFillCanvas.width = image.naturalWidth;
    eraseFillCanvas.height = image.naturalHeight;
  }
  if (paintCanvas) {
    paintCanvas.width = image.naturalWidth;
    paintCanvas.height = image.naturalHeight;
  }
  const restoredEdit = savedEdit || createLegacyPhotoEditState(source);
  const sharedZoom = state.standardCropZoom;
  documentCrop.current = {
    stepKey,
    image,
    source,
    templateImages,
    eraseCanvas,
    eraseFillCanvas,
    eraseFillDirty: true,
    paintCanvas,
    mode: "move",
    eraserSize: Number(restoredEdit.eraserSize) || 18,
    pencilSize: Number(restoredEdit.pencilSize) || 18,
    sticker: restoredEdit.sticker ? { ...restoredEdit.sticker } : null,
    rotation: Number(restoredEdit.rotation) || 0,
    zoom: sharedZoom || Number(restoredEdit.zoom) || 1,
    offsetX: Number(restoredEdit.offsetX) || 0,
    offsetY: Number(restoredEdit.offsetY) || 0,
    dragStart: null,
    eraseStart: false,
    pencilStart: false,
    brushLastPoint: null,
    brushHistory: Array.isArray(restoredEdit.brushHistory) ? clonePhotoEditState(restoredEdit.brushHistory) : [],
    activeBrushStroke: null,
    stickerDragStart: null,
    activePointers: new Map(),
    pinchStartDistance: 0,
    pinchStartZoom: 1,
    renderFrame: 0,
    statusElement
  };
  rebuildBrushCanvases(documentCrop.current);

  if (title) title.textContent = `Ajuste: ${step ? step.label : "Imagem"}`;
  if (zoomInput) {
    zoomInput.min = "0.1";
    zoomInput.max = "6";
    zoomInput.value = documentCrop.current.zoom.toFixed(2);
    zoomInput.disabled = Boolean(state.standardCropZoom);
    zoomInput.title = state.standardCropZoom ? "Zoom padronizado pelo primeiro recorte desta edicao" : "";
  }
  const eraserInput = document.querySelector("#eraserSize");
  const pencilInput = document.querySelector("#pencilSize");
  if (eraserInput) eraserInput.value = String(documentCrop.current.eraserSize);
  if (pencilInput) pencilInput.value = String(documentCrop.current.pencilSize);
  if (modal) {
    modal.hidden = false;
    setModalScrollLock(true);
  }
  constrainCropOffset();
  syncFrontEditTools();
  drawCropCanvas();
  canvas?.focus();
}

function getRotatedImageSize(crop) {
  const quarterTurn = Math.abs(crop.rotation / 90) % 2 === 1;
  return {
    width: quarterTurn ? crop.image.naturalHeight : crop.image.naturalWidth,
    height: quarterTurn ? crop.image.naturalWidth : crop.image.naturalHeight
  };
}

function drawCropCanvas() {
  const crop = documentCrop.current;
  const canvas = document.querySelector("#cropCanvas");
  if (!crop || !canvas) return;

  crop.renderFrame = 0;
  drawCropToCanvas(canvas, true);
}

function requestCropCanvasDraw() {
  const crop = documentCrop.current;
  if (!crop) return;
  if (crop.renderFrame) return;

  crop.renderFrame = requestAnimationFrame(() => {
    if (documentCrop.current === crop) {
      drawCropCanvas();
    }
  });
}

function getCropTransform(crop, width, height) {
  const rotatedSize = getRotatedImageSize(crop);
  const baseScale = Math.max(width / rotatedSize.width, height / rotatedSize.height);
  const scale = baseScale * crop.zoom;
  const offsetScale = width / 333;

  return { rotatedSize, scale, offsetScale };
}

function constrainCropOffset() {
  const crop = documentCrop.current;
  const canvas = document.querySelector("#cropCanvas");
  if (!crop || !canvas) return;

  const { rotatedSize, scale, offsetScale } = getCropTransform(crop, canvas.width, canvas.height);
  const maxX = Math.max(0, ((rotatedSize.width * scale) - canvas.width) / 2 / offsetScale);
  const maxY = Math.max(0, ((rotatedSize.height * scale) - canvas.height) / 2 / offsetScale);
  crop.offsetX = clamp(crop.offsetX, -maxX, maxX);
  crop.offsetY = clamp(crop.offsetY, -maxY, maxY);
}

function drawCropToCanvas(canvas, includeBorder = false) {
  const crop = documentCrop.current;
  if (!crop || !canvas) return;

  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const { scale, offsetScale } = getCropTransform(crop, width, height);

  context.clearRect(0, 0, width, height);
  context.fillStyle = cropEraseBackground;
  context.fillRect(0, 0, width, height);
  context.save();
  context.translate(width / 2 + crop.offsetX * offsetScale, height / 2 + crop.offsetY * offsetScale);
  context.rotate((crop.rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(crop.image, -crop.image.naturalWidth / 2, -crop.image.naturalHeight / 2);
  drawImageSticker(context, crop, includeBorder);
  drawImagePaint(context, crop);
  // The eraser is the topmost edit layer so it can cover the photo, pencil and number template.
  drawImageEraseMask(context, crop);
  context.restore();

  drawFrontEdits(context, canvas, includeBorder);

  if (includeBorder) {
    context.strokeStyle = "rgba(19, 81, 180, 0.8)";
    context.lineWidth = 2;
    context.strokeRect(1, 1, width - 2, height - 2);
  }
}

function drawFrontEdits(context, canvas, includePreviewHelpers) {
  const crop = documentCrop.current;
  if (!crop || crop.stepKey !== "front") return;
}

function drawImageEraseMask(context, crop) {
  if (!crop.eraseCanvas) return;

  context.save();
  drawMaskedFill(context, crop.eraseCanvas, cropEraseFillColor, -crop.image.naturalWidth / 2, -crop.image.naturalHeight / 2);
  context.restore();
}

function drawImagePaint(context, crop) {
  if (!crop.paintCanvas) return;

  context.drawImage(crop.paintCanvas, -crop.image.naturalWidth / 2, -crop.image.naturalHeight / 2);
}

function drawImageSticker(context, crop, includePreviewHelpers) {
  if (!crop.sticker || !crop.templateImages) return;

  const sticker = crop.sticker;
  const stickerImage = crop.templateImages[sticker.templateKey] || crop.templateImages.number7;
  if (!stickerImage) return;
  const x = sticker.x - crop.image.naturalWidth / 2;
  const y = sticker.y - crop.image.naturalHeight / 2;

  context.drawImage(stickerImage, x, y, sticker.width, sticker.height);

  if (includePreviewHelpers && isStickerMode(crop.mode)) {
    context.save();
    context.setLineDash([5, 4]);
    context.strokeStyle = "rgba(19, 81, 180, 0.95)";
    context.lineWidth = 1.5 / getPreviewScale();
    context.strokeRect(x, y, sticker.width, sticker.height);
    context.restore();
  }
}

function drawMaskedFill(context, maskCanvas, color, x, y) {
  const crop = documentCrop.current;
  const fillCanvas = crop && crop.eraseFillCanvas;
  if (!fillCanvas) return;

  if (crop.eraseFillDirty) {
    const fillContext = fillCanvas.getContext("2d");
    fillContext.globalCompositeOperation = "source-over";
    fillContext.clearRect(0, 0, fillCanvas.width, fillCanvas.height);
    fillContext.fillStyle = color;
    fillContext.fillRect(0, 0, fillCanvas.width, fillCanvas.height);
    fillContext.globalCompositeOperation = "destination-in";
    fillContext.drawImage(maskCanvas, 0, 0);
    fillContext.globalCompositeOperation = "source-over";
    crop.eraseFillDirty = false;
  }

  context.drawImage(fillCanvas, x, y);
}

function getPreviewScale() {
  const crop = documentCrop.current;
  const canvas = document.querySelector("#cropCanvas");
  if (!crop || !canvas) return 1;
  return getCropTransform(crop, canvas.width, canvas.height).scale;
}

function getActivePointerDistance(crop) {
  if (!crop || !crop.activePointers || crop.activePointers.size < 2) return 0;
  const points = Array.from(crop.activePointers.values());
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function resetCropPointerActions(crop) {
  if (!crop) return;
  crop.dragStart = null;
  crop.eraseStart = false;
  crop.pencilStart = false;
  crop.brushLastPoint = null;
  crop.activeBrushStroke = null;
  crop.stickerDragStart = null;
}

function applyCropPinchZoom(crop, zoomInput) {
  if (!crop || !zoomInput || crop.pinchStartDistance <= 0) return;
  const distance = getActivePointerDistance(crop);
  if (distance <= 0) return;

  const minZoom = Number(zoomInput.min || 0.1);
  const maxZoom = Number(zoomInput.max || 4);
  crop.zoom = clamp(crop.pinchStartZoom * (distance / crop.pinchStartDistance), minZoom, maxZoom);
  zoomInput.value = crop.zoom.toFixed(2);
  constrainCropOffset();
  drawCropCanvas();
}

function isStickerMode(mode) {
  return mode === "sticker7" || mode === "sticker0";
}

function stickerKeyFromMode(mode) {
  return mode === "sticker0" ? "number0" : "number7";
}

function closeCropper(clearInput = false) {
  const crop = documentCrop.current;
  const modal = document.querySelector("#cropModal");
  if (modal) modal.hidden = true;
  if (!document.querySelector("#photoEditModal:not([hidden]), #transferIdentityModal:not([hidden])")) {
    setModalScrollLock(false);
  }
  if (clearInput && crop) {
    const input = document.querySelector(`input[name="${crop.stepKey}"], input[name="edit-${crop.stepKey}"]`);
    if (input) input.value = "";
  }
  resetCropState();
  syncFrontEditTools();
}

function applyCropperResult() {
  const crop = documentCrop.current;
  if (!crop) return;
  constrainCropOffset();

  const output = document.createElement("canvas");
  output.width = documentCrop.width;
  output.height = documentCrop.height;
  drawCropToCanvas(output, false);
  state.croppedPhotos[crop.stepKey] = output.toDataURL("image/jpeg", 0.92);
  if (!state.standardCropZoom) state.standardCropZoom = crop.zoom;
  state.photoEditStates[crop.stepKey] = {
    source: crop.source,
    rotation: crop.rotation,
    zoom: state.standardCropZoom,
    offsetX: crop.offsetX,
    offsetY: crop.offsetY,
    eraserSize: crop.eraserSize,
    pencilSize: crop.pencilSize,
    sticker: crop.sticker ? { ...crop.sticker } : null,
    brushHistory: clonePhotoEditState(crop.brushHistory) || []
  };

  const status = crop.statusElement || document.querySelector(`[data-crop-status="${crop.stepKey}"]`);
  if (status) {
    status.textContent = `Recorte pronto - ${documentCrop.width}x${documentCrop.height}`;
    status.classList.add("ready");
  }
  closeCropper(false);
}

function bindCropperEvents() {
  const canvas = document.querySelector("#cropCanvas");
  const zoomInput = document.querySelector("#cropZoom");
  if (!canvas || !zoomInput) return;

  zoomInput.addEventListener("input", () => {
    if (!documentCrop.current || zoomInput.disabled) return;
    documentCrop.current.zoom = Number(zoomInput.value);
    constrainCropOffset();
    drawCropCanvas();
  });

  canvas.addEventListener("pointerdown", (event) => {
    const crop = documentCrop.current;
    if (!crop) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    crop.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (crop.activePointers.size >= 2) {
      resetCropPointerActions(crop);
      crop.pinchStartDistance = getActivePointerDistance(crop);
      crop.pinchStartZoom = crop.zoom;
      return;
    }

    if (crop.stepKey === "front" && crop.mode === "erase") {
      crop.eraseStart = true;
      crop.brushLastPoint = null;
      startBrushStroke("erase");
      applyBrushFromPointerEvent(event, "erase");
      return;
    }

    if (crop.stepKey === "front" && crop.mode === "pencil") {
      crop.pencilStart = true;
      crop.brushLastPoint = null;
      startBrushStroke("pencil");
      applyBrushFromPointerEvent(event, "pencil");
      return;
    }

    if (crop.stepKey === "front" && isStickerMode(crop.mode)) {
      const point = getImagePoint(event);
      if (!point) return;
      if (!crop.sticker || !isPointerOnSticker(event)) {
        placeNumberStickerAt(point.x, point.y, stickerKeyFromMode(crop.mode));
      }
      crop.stickerDragStart = {
        x: point.x,
        y: point.y,
        stickerX: crop.sticker.x,
        stickerY: crop.sticker.y
      };
      return;
    }

    crop.dragStart = {
      x: event.clientX,
      y: event.clientY,
      offsetX: crop.offsetX,
      offsetY: crop.offsetY
    };
  });

  canvas.addEventListener("pointermove", (event) => {
    const crop = documentCrop.current;
    if (!crop) return;
    event.preventDefault();
    if (crop.activePointers && crop.activePointers.has(event.pointerId)) {
      crop.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (crop.activePointers && crop.activePointers.size >= 2) {
      applyCropPinchZoom(crop, zoomInput);
      return;
    }

    if (crop.eraseStart) {
      applyBrushFromPointerEvent(event, "erase");
      return;
    }

    if (crop.pencilStart) {
      applyBrushFromPointerEvent(event, "pencil");
      return;
    }

    if (crop.stickerDragStart && crop.sticker) {
      const point = getImagePoint(event);
      if (!point) return;
      crop.sticker.x = clamp(crop.stickerDragStart.stickerX + point.x - crop.stickerDragStart.x, -crop.sticker.width / 2, crop.image.naturalWidth - crop.sticker.width / 2);
      crop.sticker.y = clamp(crop.stickerDragStart.stickerY + point.y - crop.stickerDragStart.y, -crop.sticker.height / 2, crop.image.naturalHeight - crop.sticker.height / 2);
      drawCropCanvas();
      return;
    }

    if (!crop.dragStart) return;
    crop.offsetX = crop.dragStart.offsetX + event.clientX - crop.dragStart.x;
    crop.offsetY = crop.dragStart.offsetY + event.clientY - crop.dragStart.y;
    constrainCropOffset();
    drawCropCanvas();
  });

  function endCropPointer(event) {
    const crop = documentCrop.current;
    if (!crop) return;
    if (crop.activePointers) crop.activePointers.delete(event.pointerId);
    crop.pinchStartDistance = 0;
    crop.pinchStartZoom = crop.zoom;
    resetCropPointerActions(crop);
  }

  canvas.addEventListener("pointerup", endCropPointer);
  canvas.addEventListener("pointercancel", endCropPointer);
  canvas.addEventListener("pointerleave", endCropPointer);

  document.querySelector("#cropRotateLeft")?.addEventListener("click", () => {
    if (!documentCrop.current) return;
    documentCrop.current.rotation = (documentCrop.current.rotation - 90 + 360) % 360;
    constrainCropOffset();
    drawCropCanvas();
  });

  document.querySelector("#cropRotateRight")?.addEventListener("click", () => {
    if (!documentCrop.current) return;
    documentCrop.current.rotation = (documentCrop.current.rotation + 90) % 360;
    constrainCropOffset();
    drawCropCanvas();
  });

  document.querySelector("#cropApply")?.addEventListener("click", applyCropperResult);
  document.querySelector("#cropCancel")?.addEventListener("click", () => closeCropper(true));
  document.querySelector("#cropCancelFooter")?.addEventListener("click", () => closeCropper(true));
  document.querySelector("#eraserSize")?.addEventListener("input", (event) => {
    if (!documentCrop.current) return;
    documentCrop.current.eraserSize = Number(event.target.value);
  });
  document.querySelector("#pencilSize")?.addEventListener("input", (event) => {
    if (!documentCrop.current) return;
    documentCrop.current.pencilSize = Number(event.target.value);
  });
  document.querySelector("#stickerSize")?.addEventListener("input", (event) => {
    resizeNumberSticker(Number(event.target.value));
  });
  document.querySelector("#addNumberSticker")?.addEventListener("click", addNumberSticker);
  document.querySelector("#addNumberZeroSticker")?.addEventListener("click", addNumberZeroSticker);
  document.querySelector("#undoBrushStroke")?.addEventListener("click", undoBrushStroke);
  document.querySelectorAll("[data-crop-mode]").forEach((button) => {
    button.addEventListener("click", () => setCropMode(button.dataset.cropMode));
  });
}

function syncFrontEditTools() {
  const crop = documentCrop.current;
  const tools = document.querySelector("#frontEditTools");
  const note = document.querySelector(".crop-controls .form-note");
  if (tools) tools.hidden = !(crop && crop.stepKey === "front");
  syncBrushUndoButton();
  if (note) {
    note.textContent = crop && crop.stepKey === "front"
      ? "O primeiro recorte define o zoom das demais fotos. A borracha cobre foto, lapis e numeros; Desfazer pode ser usado varias vezes."
      : "Arraste para centralizar. O primeiro recorte define o mesmo percentual de zoom para todas as fotos.";
  }
  setCropMode(crop && crop.stepKey === "front" ? crop.mode : "move");
}

function setCropMode(mode) {
  const crop = documentCrop.current;
  if (crop && crop.stepKey === "front") crop.mode = mode || "move";
  document.querySelectorAll("[data-crop-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.cropMode === (crop ? crop.mode : "move"));
  });
  drawCropCanvas();
}

function syncBrushUndoButton() {
  const button = document.querySelector("#undoBrushStroke");
  if (!button) return;
  const crop = documentCrop.current;
  button.disabled = !(crop && crop.stepKey === "front" && crop.brushHistory && crop.brushHistory.length);
}

function getCanvasPoint(event) {
  return getCanvasPointFromClient(event.clientX, event.clientY);
}

function getCanvasPointFromClient(clientX, clientY) {
  const canvas = document.querySelector("#cropCanvas");
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((clientX - rect.left) / rect.width) * canvas.width,
    y: ((clientY - rect.top) / rect.height) * canvas.height
  };
}

function getImagePoint(event) {
  return getImagePointFromCanvasPoint(getCanvasPoint(event));
}

function getImagePointFromClient(clientX, clientY) {
  return getImagePointFromCanvasPoint(getCanvasPointFromClient(clientX, clientY));
}

function getImagePointFromCanvasPoint(point) {
  const crop = documentCrop.current;
  const canvas = document.querySelector("#cropCanvas");
  if (!crop || !canvas) return null;

  const { scale, offsetScale } = getCropTransform(crop, canvas.width, canvas.height);
  const centerX = canvas.width / 2 + crop.offsetX * offsetScale;
  const centerY = canvas.height / 2 + crop.offsetY * offsetScale;
  const dx = point.x - centerX;
  const dy = point.y - centerY;
  const radians = -(crop.rotation * Math.PI) / 180;
  const rotatedX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const rotatedY = dx * Math.sin(radians) + dy * Math.cos(radians);

  return {
    x: rotatedX / scale + crop.image.naturalWidth / 2,
    y: rotatedY / scale + crop.image.naturalHeight / 2,
    eraseRadius: Math.max(0.5, (crop.eraserSize * (canvas.width / documentCrop.width)) / 2 / scale),
    pencilRadius: Math.max(0.5, (crop.pencilSize * (canvas.width / documentCrop.width)) / 2 / scale)
  };
}

function getBrushPointerEvents(event) {
  return typeof event.getCoalescedEvents === "function"
    ? event.getCoalescedEvents()
    : [event];
}

function startBrushStroke(tool) {
  const crop = documentCrop.current;
  if (!crop) return;
  if (crop.brushHistory.length >= 500) crop.brushHistory.shift();
  crop.activeBrushStroke = { tool, points: [] };
  crop.brushHistory.push(crop.activeBrushStroke);
  syncBrushUndoButton();
}

function undoBrushStroke() {
  const crop = documentCrop.current;
  if (!crop || !crop.brushHistory || !crop.brushHistory.length) return;
  crop.brushHistory.pop();
  crop.activeBrushStroke = null;
  crop.brushLastPoint = null;
  rebuildBrushCanvases(crop);
  syncBrushUndoButton();
  drawCropCanvas();
}

function rebuildBrushCanvases(crop) {
  if (!crop) return;
  for (const layer of [crop.eraseCanvas, crop.paintCanvas]) {
    if (layer) layer.getContext("2d").clearRect(0, 0, layer.width, layer.height);
  }
  crop.eraseFillDirty = true;
  crop.brushLastPoint = null;
  for (const stroke of crop.brushHistory || []) {
    crop.brushLastPoint = null;
    for (const point of stroke.points || []) {
      drawBrushAtImagePoint(point, stroke.tool, false);
    }
  }
  crop.brushLastPoint = null;
}

function applyBrushFromPointerEvent(event, tool) {
  const crop = documentCrop.current;
  if (!crop) return;

  for (const pointerEvent of getBrushPointerEvents(event)) {
    const point = getImagePointFromClient(pointerEvent.clientX, pointerEvent.clientY);
    if (!point) continue;
    drawBrushAtImagePoint(point, tool);
  }
  requestCropCanvasDraw();
}

function drawBrushAtImagePoint(point, tool, recordPoint = true) {
  const crop = documentCrop.current;
  if (!crop) return;

  const targetCanvas = tool === "erase" ? crop.eraseCanvas : crop.paintCanvas;
  if (!targetCanvas) return;

  const radius = tool === "erase" ? point.eraseRadius : point.pencilRadius;
  const context = targetCanvas.getContext("2d");
  const previous = crop.brushLastPoint;

  context.save();
  context.fillStyle = tool === "erase" ? "#000" : cropPencilColor;
  context.strokeStyle = context.fillStyle;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = radius * 2;

  if (previous && previous.tool === tool) {
    const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(radius * 0.7, 1)));
    context.beginPath();
    context.moveTo(previous.x, previous.y);
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      context.lineTo(
        previous.x + (point.x - previous.x) * progress,
        previous.y + (point.y - previous.y) * progress
      );
    }
    context.stroke();
  } else {
    context.beginPath();
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
  }

  context.restore();
  crop.brushLastPoint = { x: point.x, y: point.y, tool };
  if (recordPoint && crop.activeBrushStroke) {
    crop.activeBrushStroke.points.push({
      x: point.x,
      y: point.y,
      eraseRadius: point.eraseRadius,
      pencilRadius: point.pencilRadius
    });
  }
  if (tool === "erase") {
    crop.eraseFillDirty = true;
  }
}

function eraseAtCanvasPoint(event) {
  const crop = documentCrop.current;
  if (!crop || !crop.eraseCanvas) return;
  const point = getImagePoint(event);
  if (!point) return;
  drawBrushAtImagePoint(point, "erase");
  requestCropCanvasDraw();
}

function paintAtCanvasPoint(event) {
  const crop = documentCrop.current;
  if (!crop || !crop.paintCanvas) return;
  const point = getImagePoint(event);
  if (!point) return;
  drawBrushAtImagePoint(point, "pencil");
  requestCropCanvasDraw();
}

function isPointerOnSticker(event) {
  const crop = documentCrop.current;
  if (!crop || !crop.sticker) return false;
  const point = getImagePoint(event);
  if (!point) return false;
  const sticker = crop.sticker;
  return point.x >= sticker.x && point.x <= sticker.x + sticker.width && point.y >= sticker.y && point.y <= sticker.y + sticker.height;
}

function addNumberSticker() {
  addSticker("number7");
}

function addNumberZeroSticker() {
  addSticker("number0");
}

function addSticker(templateKey) {
  const crop = documentCrop.current;
  if (!crop) return;
  const canvas = document.querySelector("#cropCanvas");
  const visibleCenter = canvas
    ? getImagePointFromCanvasPoint({ x: canvas.width / 2, y: canvas.height / 2 })
    : null;
  placeNumberStickerAt(
    visibleCenter ? visibleCenter.x : crop.image.naturalWidth / 2,
    visibleCenter ? visibleCenter.y : crop.image.naturalHeight / 2,
    templateKey
  );
}

function placeNumberStickerAt(centerX, centerY, templateKey = "number7") {
  const crop = documentCrop.current;
  const stickerImage = crop && crop.templateImages ? crop.templateImages[templateKey] : null;
  if (!crop || crop.stepKey !== "front" || !stickerImage) return;
  const width = getStickerImageWidth(Number(document.querySelector("#stickerSize")?.value || 150));
  const height = width * (stickerImage.naturalHeight / stickerImage.naturalWidth);
  crop.sticker = {
    templateKey,
    x: clamp(centerX - width / 2, -width / 2, crop.image.naturalWidth - width / 2),
    y: clamp(centerY - height / 2, -height / 2, crop.image.naturalHeight - height / 2),
    width,
    height
  };
  setCropMode(templateKey === "number0" ? "sticker0" : "sticker7");
}

function resizeNumberSticker(width) {
  const crop = documentCrop.current;
  const stickerImage = crop && crop.sticker && crop.templateImages ? crop.templateImages[crop.sticker.templateKey] : null;
  if (!crop || !crop.sticker || !stickerImage) return;
  const centerX = crop.sticker.x + crop.sticker.width / 2;
  const centerY = crop.sticker.y + crop.sticker.height / 2;
  const imageWidth = getStickerImageWidth(width);
  const height = imageWidth * (stickerImage.naturalHeight / stickerImage.naturalWidth);
  crop.sticker.width = imageWidth;
  crop.sticker.height = height;
  crop.sticker.x = clamp(centerX - imageWidth / 2, -imageWidth / 2, crop.image.naturalWidth - imageWidth / 2);
  crop.sticker.y = clamp(centerY - height / 2, -height / 2, crop.image.naturalHeight - height / 2);
  drawCropCanvas();
}

function getStickerImageWidth(outputWidth) {
  const crop = documentCrop.current;
  const canvas = document.querySelector("#cropCanvas");
  if (!crop || !canvas) return outputWidth;
  const previewScale = canvas.width / documentCrop.width;
  const imageScale = getCropTransform(crop, canvas.width, canvas.height).scale;
  return Math.max(1, (outputWidth * previewScale) / imageScale);
}

async function renderStoredPhotoEdit(stepKey, edit) {
  if (!edit || !edit.source) return "";
  const image = await loadImage(edit.source);
  const isFront = stepKey === "front";
  const makeLayer = () => {
    const layer = document.createElement("canvas");
    layer.width = image.naturalWidth;
    layer.height = image.naturalHeight;
    return layer;
  };
  const crop = {
    stepKey,
    image,
    source: edit.source,
    templateImages: isFront ? {
      number7: await loadImage(cropTemplateAssets.number7),
      number0: await loadImage(cropTemplateAssets.number0)
    } : {},
    eraseCanvas: isFront ? makeLayer() : null,
    eraseFillCanvas: isFront ? makeLayer() : null,
    eraseFillDirty: true,
    paintCanvas: isFront ? makeLayer() : null,
    mode: "move",
    eraserSize: Number(edit.eraserSize) || 18,
    pencilSize: Number(edit.pencilSize) || 18,
    sticker: edit.sticker ? { ...edit.sticker } : null,
    rotation: Number(edit.rotation) || 0,
    zoom: Number(edit.zoom) || 1,
    offsetX: Number(edit.offsetX) || 0,
    offsetY: Number(edit.offsetY) || 0,
    brushHistory: clonePhotoEditState(edit.brushHistory) || [],
    brushLastPoint: null,
    activeBrushStroke: null
  };
  const previousCrop = documentCrop.current;
  documentCrop.current = crop;
  try {
    rebuildBrushCanvases(crop);
    constrainCropOffset();
    edit.offsetX = crop.offsetX;
    edit.offsetY = crop.offsetY;
    const output = document.createElement("canvas");
    output.width = documentCrop.width;
    output.height = documentCrop.height;
    drawCropToCanvas(output, false);
    return output.toDataURL("image/jpeg", 0.92);
  } finally {
    documentCrop.current = previousCrop;
  }
}

async function standardizeSavedPhotoZooms() {
  if (!state.standardCropZoom) return;
  for (const step of documentUploadSteps) {
    const edit = state.photoEditStates[step.key];
    if (!edit || !edit.source) continue;
    edit.zoom = state.standardCropZoom;
    state.croppedPhotos[step.key] = await renderStoredPhotoEdit(step.key, edit);
  }
}

async function readOrderedPhotoSlides(form) {
  const slides = [];

  for (const step of requiredDocumentUploadSteps) {
    const file = form.get(step.key);
    if (!(file instanceof File) || !file.name) {
      throw new Error(`Anexe a foto: ${step.label}.`);
    }
    if (!acceptedPhotoTypes.split(",").includes(file.type)) {
      throw new Error(`A foto "${step.label}" deve ser JPG, PNG, WEBP, HEIC, HEIF, GIF ou BMP.`);
    }
    if (file.size > maxPhotoSizeBytes) {
      throw new Error(`A foto "${step.label}" deve ter no maximo 4 MB.`);
    }
    if (!state.croppedPhotos[step.key]) {
      throw new Error(`Aplique o recorte da foto: ${step.label}.`);
    }
    slides.push(state.croppedPhotos[step.key]);
  }

  if (state.croppedPhotos.qr) {
    slides.push(state.croppedPhotos.qr);
  }

  return slides;
}

async function renderIdentityPage() {
  const hasUser = await ensureUser();
  if (!hasUser) {
    goTo("/auth", true);
    return;
  }

  await loadIdentities();
  if (!state.identities.length) {
    goTo("/dashboard", true);
    return;
  }

  const params = new URLSearchParams(window.location.search);
  const selected = state.identities.find((identity) => identity.id === params.get("id")) || state.identities[0];
  renderIdentityView(selected);
}

async function renderRoute() {
  const path = window.location.pathname;

  if (path === "/auth") {
    const hasUser = await ensureUser();
    if (hasUser) {
      goTo("/dashboard", true);
      return;
    }
    renderAuthPage();
    return;
  }

  if (path === "/dashboard") {
    renderDashboardPage();
    return;
  }

  if (path === "/identidadefake") {
    renderIdentityPage();
    return;
  }

  goTo("/auth", true);
}

function bindEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode;
      renderAuthPage();
    });
  });

  const authForm = document.querySelector("#authForm");
  if (authForm) {
    authForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(authForm);
      const path = state.authMode === "login" ? "/api/auth/login" : "/api/auth/register";

      try {
        const payload = await api(path, {
          method: "POST",
          body: JSON.stringify({
            name: form.get("name"),
            username: form.get("username"),
            login: form.get("login"),
            password: form.get("password")
          })
        });
        state.user = payload.user;
        state.csrfToken = payload.csrfToken || "";
        goTo("/dashboard");
      } catch (error) {
        renderAuthPage(error.message);
      }
    });
  }

  const identityForm = document.querySelector("#identityForm");
  if (identityForm) {
    bindCropperEvents();
    documentUploadSteps.forEach((step) => {
      const input = identityForm.querySelector(`input[name="${step.key}"]`);
      input?.addEventListener("change", async () => {
        delete state.croppedPhotos[step.key];
        delete state.photoEditStates[step.key];
        const status = document.querySelector(`[data-crop-status="${step.key}"]`);
        if (status) {
          status.textContent = step.key === "qr"
            ? "QR padrao sera usado se nenhum arquivo for enviado."
            : `Recorte pendente - ${documentCrop.width}x${documentCrop.height}`;
          status.classList.toggle("ready", step.key === "qr");
        }

        try {
          await openCropper(step.key, input.files && input.files[0]);
        } catch (error) {
          input.value = "";
          if (status) status.textContent = error.message;
        }
      });
    });

    identityForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = new FormData(identityForm);

      const currentMessage = identityForm.querySelector("[data-form-error]");
      if (currentMessage) {
        currentMessage.remove();
      }

      try {
        await api("/api/identities", {
          method: "POST",
          body: JSON.stringify({
            title: form.get("title"),
            displayName: form.get("displayName"),
            cpf: form.get("cpf"),
            userId: form.get("userId"),
            photoSlides: await readOrderedPhotoSlides(form),
            photoEditStates: state.photoEditStates
          })
        });

        state.croppedPhotos = {};
        renderDashboardPage();
      } catch (error) {
        identityForm.insertAdjacentHTML("beforeend", `<p class="form-message" data-form-error>${escapeHtml(error.message)}</p>`);
      }
    });
  }

  const photoEditForm = document.querySelector("#photoEditForm");
  if (photoEditForm) {
    documentUploadSteps.forEach((step) => {
      const input = photoEditForm.querySelector(`input[name="edit-${step.key}"]`);
      input?.addEventListener("change", async () => {
        delete state.croppedPhotos[step.key];
        delete state.photoEditStates[step.key];
        const status = photoEditForm.querySelector(`[data-edit-crop-status="${step.key}"]`);
        if (status) {
          status.textContent = `Recorte pendente - ${documentCrop.width}x${documentCrop.height}`;
          status.classList.remove("ready");
        }

        try {
          await openCropper(step.key, input.files && input.files[0], status);
        } catch (error) {
          input.value = "";
          if (status) status.textContent = error.message;
        }
      });
    });

    photoEditForm.querySelectorAll("[data-edit-current-photo]").forEach((button) => {
      button.addEventListener("click", async () => {
        const stepKey = button.dataset.editCurrentPhoto;
        const savedEdit = state.photoEditStates[stepKey];
        const status = photoEditForm.querySelector(`[data-edit-crop-status="${stepKey}"]`);
        if (!savedEdit || !savedEdit.source) return;
        try {
          await openCropper(stepKey, null, status, clonePhotoEditState(savedEdit));
        } catch (error) {
          if (status) status.textContent = error.message;
        }
      });
    });

    photoEditForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.editingPhotosFor) return;

      const currentMessage = photoEditForm.querySelector("[data-form-error]");
      if (currentMessage) currentMessage.remove();

      try {
        await standardizeSavedPhotoZooms();
        const photoSlides = requiredDocumentUploadSteps.map((step) => {
          if (!state.croppedPhotos[step.key]) {
            throw new Error(`Aplique o recorte da foto: ${step.label}.`);
          }
          return state.croppedPhotos[step.key];
        });
        if (state.croppedPhotos.qr) {
          photoSlides.push(state.croppedPhotos.qr);
        }

        await api(`/api/identities/${encodeURIComponent(state.editingPhotosFor)}`, {
          method: "PATCH",
          body: JSON.stringify({ photoSlides, photoEditStates: state.photoEditStates })
        });
        closePhotoEditModal();
        renderDashboardPage();
      } catch (error) {
        photoEditForm.insertAdjacentHTML("beforeend", `<p class="form-message" data-form-error>${escapeHtml(error.message)}</p>`);
      }
    });
  }

  document.querySelector("#photoEditClose")?.addEventListener("click", closePhotoEditModal);
  document.querySelector("#photoEditCancel")?.addEventListener("click", closePhotoEditModal);

  const transferIdentityForm = document.querySelector("#transferIdentityForm");
  if (transferIdentityForm) {
    transferIdentityForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!state.transferringIdentityFor) return;
      const form = new FormData(transferIdentityForm);
      const targetUserId = String(form.get("targetUserId") || "");
      const currentMessage = transferIdentityForm.querySelector("[data-form-error]");
      if (currentMessage) currentMessage.remove();

      try {
        if (!targetUserId) throw new Error("Selecione um usuario destino.");
        await api(`/api/identities/${encodeURIComponent(state.transferringIdentityFor)}/transfer`, {
          method: "POST",
          body: JSON.stringify({ targetUserId })
        });
        closeTransferIdentityModal();
        renderDashboardPage();
      } catch (error) {
        transferIdentityForm.insertAdjacentHTML("beforeend", `<p class="form-message" data-form-error>${escapeHtml(error.message)}</p>`);
      }
    });
  }

  document.querySelector("#transferIdentityClose")?.addEventListener("click", closeTransferIdentityModal);
  document.querySelector("#transferIdentityCancel")?.addEventListener("click", closeTransferIdentityModal);

  document.querySelectorAll("[data-open-identity]").forEach((button) => {
    button.addEventListener("click", () => {
      goTo(`/identidadefake?id=${encodeURIComponent(button.dataset.openIdentity)}`);
    });
  });

  document.querySelectorAll("[data-rename-identity]").forEach((button) => {
    button.addEventListener("click", async () => {
      const identity = state.identities.find((item) => item.id === button.dataset.renameIdentity);
      if (!identity) return;
      const title = window.prompt("Novo titulo da identidade:", identity.title || "");
      if (title === null) return;
      const trimmedTitle = title.trim();
      if (!trimmedTitle) {
        window.alert("Informe um titulo valido.");
        return;
      }
      await api(`/api/identities/${encodeURIComponent(identity.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ title: trimmedTitle })
      });
      renderDashboardPage();
    });
  });

  document.querySelectorAll("[data-edit-identity-photos]").forEach((button) => {
    button.addEventListener("click", () => {
      openPhotoEditModal(button.dataset.editIdentityPhotos);
    });
  });

  document.querySelectorAll("[data-transfer-identity]").forEach((button) => {
    button.addEventListener("click", () => {
      openTransferIdentityModal(button.dataset.transferIdentity);
    });
  });

  document.querySelectorAll("[data-remove-identity]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Remover esta identidade?")) return;
      await api(`/api/identities/${encodeURIComponent(button.dataset.removeIdentity)}`, {
        method: "DELETE"
      });
      renderDashboardPage();
    });
  });

  document.querySelectorAll("[data-remove-user]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!window.confirm("Remover este usuario e todas as identidades dele?")) return;
      await api(`/api/users/${encodeURIComponent(button.dataset.removeUser)}`, {
        method: "DELETE"
      });
      renderDashboardPage();
    });
  });

  const logoutButton = document.querySelector("#logoutButton");
  if (logoutButton) {
    logoutButton.addEventListener("click", async () => {
      await api("/api/auth/logout", { method: "POST" });
      state.user = null;
      state.identities = [];
      state.users = [];
      state.csrfToken = "";
      goTo("/auth");
    });
  }

  const backDashboard = document.querySelector("#backDashboard");
  if (backDashboard) {
    backDashboard.addEventListener("click", () => goTo("/dashboard"));
  }

  document.querySelectorAll("#documentCloseDashboard").forEach((button) => {
    button.addEventListener("click", () => goTo("/dashboard"));
  });

  const addFromIdentity = document.querySelector("#addFromIdentity");
  if (addFromIdentity) {
    addFromIdentity.addEventListener("click", () => goTo("/dashboard"));
  }
}

window.addEventListener("popstate", renderRoute);
renderRoute();
