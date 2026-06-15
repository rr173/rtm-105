const API_BASE = window.location.protocol === 'file:' 
  ? 'http://localhost:3000' 
  : 'http://localhost:3000';

const STATE_WIDTH = 120;
const STATE_HEIGHT = 60;
const STATE_RADIUS = 10;

function uid() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

class WorkflowApp {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.ctx = this.canvas.getContext('2d');
    
    this.currentName = '未命名状态机';
    this.states = [];
    this.transitions = [];
    this.isDesignMode = true;
    
    this.selectedNode = null;
    this.selectedTransition = null;
    this.draggingNode = null;
    this.dragOffset = { x: 0, y: 0 };
    
    this.creatingEdge = null;
    this.edgeFrom = null;
    this.edgeTo = null;
    
    this.flashingArrows = new Map();
    
    this.machines = [];
    this.selectedMachine = null;
    this.instances = [];
    this.selectedInstance = null;
    this.instanceStates = new Map();
    
    this.ws = null;
    
    this.templates = [];
    this.selectedTemplate = null;
    this.previewCtx = null;
    
    this.violations = [];
    this.selectedViolationId = null;
    this.highlightedStateId = null;
    this.violationStatsTimer = null;
    this.flashBadgeTimer = null;
    
    this.machineGroups = [];
    this.expandedGroups = new Set();
    this.migrationSourceMachine = null;
    this.migrationTargetMachineId = null;
    this.migrationSelectedInstances = new Set();
    this.migrationCheckResult = null;
    this.latestVersions = new Map();

    this.takeoverSessions = [];
    this.currentTakeoverSession = null;
    this.takeoverSessionDetail = null;
    this.takeoverPendingAction = null;
    this.takeoverOperatorName = localStorage.getItem('takeoverOperatorName') || '';
    this.takeoverOperatorId = 'user_' + Math.random().toString(36).slice(2, 10);
    this.takeoverRefreshTimer = null;
    this.takeoverCurrentTab = 'inject';
    this.takeoverPreviewResult = null;
    
    this.init();
  }
  
  init() {
    this.resizeCanvas();
    window.addEventListener('resize', () => this.resizeCanvas());
    this.bindCanvasEvents();
    this.bindUIEvents();
    this.render();
    this.loadMachines();
    this.startRenderLoop();
  }
  
  resizeCanvas() {
    const wrapper = this.canvas.parentElement;
    const wrapperW = wrapper.clientWidth;
    const wrapperH = wrapper.clientHeight;
    
    let maxX = 0, maxY = 0;
    for (const s of this.states) {
      maxX = Math.max(maxX, s.x + STATE_WIDTH + 60);
      maxY = Math.max(maxY, s.y + STATE_HEIGHT + 60);
    }
    
    const canvasW = Math.max(wrapperW, maxX);
    const canvasH = Math.max(wrapperH, maxY);
    
    this.canvas.width = canvasW;
    this.canvas.height = canvasH;
    this.canvas.style.width = canvasW + 'px';
    this.canvas.style.height = canvasH + 'px';
  }
  
  startRenderLoop() {
    const loop = () => {
      this.render();
      requestAnimationFrame(loop);
    };
    loop();
  }
  
  bindCanvasEvents() {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
    this.canvas.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    this.canvas.addEventListener('click', (e) => this.onClick(e));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  
  bindUIEvents() {
    document.getElementById('btn-new').addEventListener('click', () => this.newMachine());
    document.getElementById('btn-publish').addEventListener('click', () => this.publishMachine());
    document.getElementById('btn-create-instance').addEventListener('click', () => this.createInstance());
    document.getElementById('btn-send-event').addEventListener('click', () => this.sendEvent());
    document.getElementById('btn-clear-violations').addEventListener('click', () => this.clearViolations());
    this.bindTemplateMarketEvents();
    this.bindMigrationEvents();
    this.bindTakeoverEvents();
  }

  bindMigrationEvents() {
    document.getElementById('btn-close-migration').addEventListener('click', () => this.closeMigrationModal());
    document.getElementById('migration-modal').addEventListener('click', (e) => {
      if (e.target.id === 'migration-modal') this.closeMigrationModal();
    });
    document.getElementById('migration-target-select').addEventListener('change', (e) => this.onTargetVersionChange(e.target.value));
    document.getElementById('btn-check-migration').addEventListener('click', () => this.checkMigration());
    document.getElementById('btn-back-to-select').addEventListener('click', () => this.showMigrationStep('select'));
    document.getElementById('btn-execute-migration').addEventListener('click', () => this.executeMigration());
    document.getElementById('btn-close-migration-result').addEventListener('click', () => this.closeMigrationModal());
  }

  bindTemplateMarketEvents() {
    document.getElementById('btn-open-market').addEventListener('click', () => this.openTemplateMarket());
    document.getElementById('btn-close-market').addEventListener('click', () => this.closeTemplateMarket());
    document.getElementById('template-modal').addEventListener('click', (e) => {
      if (e.target.id === 'template-modal') this.closeTemplateMarket();
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchTab(btn.dataset.tab));
    });

    document.getElementById('tpl-search').addEventListener('input', () => this.loadTemplates());
    document.getElementById('tpl-sort').addEventListener('change', () => this.loadTemplates());
    document.getElementById('tpl-tag-filter').addEventListener('change', () => this.loadTemplates());

    document.getElementById('btn-submit-publish').addEventListener('click', () => this.submitPublishTemplate());

    document.getElementById('btn-back-list').addEventListener('click', () => this.showTemplateList());
    document.getElementById('btn-clone-template').addEventListener('click', () => this.cloneTemplate());
    document.getElementById('btn-delete-template').addEventListener('click', () => this.deleteTemplate());
  }

  openTemplateMarket() {
    document.getElementById('template-modal').style.display = 'flex';
    this.switchTab('browse');
    this.populatePublishMachineSelect();
    this.loadTemplates();
  }

  closeTemplateMarket() {
    document.getElementById('template-modal').style.display = 'none';
    this.showTemplateList();
  }

  switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    document.getElementById('tab-browse').style.display = tabName === 'browse' ? 'block' : 'none';
    document.getElementById('tab-publish').style.display = tabName === 'publish' ? 'block' : 'none';
    document.getElementById('template-preview').style.display = 'none';
    if (tabName === 'browse') {
      this.loadTemplates();
    } else {
      this.populatePublishMachineSelect();
    }
  }

  populatePublishMachineSelect() {
    const sel = document.getElementById('publish-machine-select');
    if (this.machines.length === 0) {
      sel.innerHTML = '<option value="">-- 暂无可发布的状态机，请先发布状态机 --</option>';
      return;
    }
    sel.innerHTML = '<option value="">-- 请选择 --</option>' +
      this.machines.map(m => `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)} (v${m.version})</option>`).join('');
  }

  async loadTemplates() {
    try {
      const search = document.getElementById('tpl-search').value.trim();
      const sort = document.getElementById('tpl-sort').value;
      const tag = document.getElementById('tpl-tag-filter').value;

      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (sort) params.set('sort', sort);
      if (tag) params.set('tag', tag);

      const res = await fetch(API_BASE + '/api/templates' + (params.toString() ? '?' + params.toString() : ''));
      this.templates = await res.json();
      this.renderTemplateList();
      this.updateTagFilterOptions();
    } catch (e) {
      toast('加载模板列表失败', 'error');
    }
  }

  updateTagFilterOptions() {
    const allTags = new Set();
    for (const t of this.templates) {
      for (const tag of t.tags) allTags.add(tag);
    }
    const sel = document.getElementById('tpl-tag-filter');
    const currentVal = sel.value;
    sel.innerHTML = '<option value="">全部标签</option>' +
      [...allTags].map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join('');
    sel.value = currentVal;
  }

  renderTemplateList() {
    const container = document.getElementById('template-list');
    if (this.templates.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#8c8c8c;padding:40px;grid-column:1/-1;">暂无匹配的模板</div>';
      return;
    }
    container.innerHTML = this.templates.map(t => `
      <div class="template-card" data-id="${escapeHtml(t.id)}">
        <div class="template-card-name">${escapeHtml(t.name)}</div>
        <div class="template-card-desc">${escapeHtml(t.description || '暂无描述')}</div>
        <div class="template-card-tags">
          ${t.tags.map(tag => `<span class="template-tag">${escapeHtml(tag)}</span>`).join('')}
        </div>
        <div class="template-card-meta">
          <span>📅 ${new Date(t.createdAt).toLocaleDateString()}</span>
          <span>👥 克隆 ${t.cloneCount} 次</span>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('.template-card').forEach(el => {
      el.onclick = () => this.showTemplatePreview(el.dataset.id);
    });
  }

  async showTemplatePreview(id) {
    try {
      const res = await fetch(API_BASE + '/api/templates/' + id);
      const tpl = await res.json();
      this.selectedTemplate = tpl;

      document.getElementById('tab-browse').style.display = 'none';
      document.getElementById('tab-publish').style.display = 'none';
      document.getElementById('template-preview').style.display = 'flex';

      document.getElementById('preview-name').textContent = tpl.name;
      document.getElementById('preview-tags').innerHTML = tpl.tags.map(tag =>
        `<span class="template-tag" style="font-size:12px;padding:3px 10px;">${escapeHtml(tag)}</span>`
      ).join('');
      document.getElementById('preview-meta').innerHTML = `
        <span style="color:#8c8c8c;font-size:12px;">
          📅 发布于 ${new Date(tpl.createdAt).toLocaleString()} &nbsp;|&nbsp;
          👥 已被克隆 ${tpl.cloneCount} 次 &nbsp;|&nbsp;
          🔗 源状态机: ${escapeHtml(tpl.machineId.slice(0, 8))}…
        </span>
      `;
      document.getElementById('preview-description').textContent = tpl.description || '暂无描述';

      const isMyTemplate = this.machines.some(m => m.id === tpl.machineId);
      document.getElementById('btn-delete-template').style.display = isMyTemplate ? 'inline-block' : 'none';

      this.renderPreviewCanvas(tpl.definition);
    } catch (e) {
      toast('加载模板详情失败', 'error');
    }
  }

  showTemplateList() {
    document.getElementById('template-preview').style.display = 'none';
    const activeTab = document.querySelector('.tab-btn.active').dataset.tab;
    document.getElementById('tab-browse').style.display = activeTab === 'browse' ? 'block' : 'none';
    document.getElementById('tab-publish').style.display = activeTab === 'publish' ? 'block' : 'none';
    this.selectedTemplate = null;
  }

  renderPreviewCanvas(definition) {
    const canvas = document.getElementById('preview-canvas');
    const ctx = canvas.getContext('2d');
    this.previewCtx = ctx;

    let maxX = 0, maxY = 0;
    for (const s of definition.states) {
      maxX = Math.max(maxX, s.x + STATE_WIDTH + 40);
      maxY = Math.max(maxY, s.y + STATE_HEIGHT + 40);
    }
    canvas.width = Math.max(800, maxX);
    canvas.height = Math.max(300, maxY);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const t of definition.transitions) {
      const from = definition.states.find(s => s.id === t.sourceStateId);
      const to = definition.states.find(s => s.id === t.targetStateId);
      if (!from || !to) continue;
      const p1 = this.getEdgePointStatic(from, to);
      const p2 = this.getEdgePointStatic(to, from);
      this.drawArrowStatic(ctx, p1.x, p1.y, p2.x, p2.y, '#8c8c8c', false, 2);
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      const label = t.guard ? `${t.event} [${t.guard}]` : t.event;
      ctx.font = '11px sans-serif';
      const labelWidth = ctx.measureText(label).width;
      const padX = 6, padY = 3;
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.strokeStyle = '#8c8c8c';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(midX - labelWidth / 2 - padX, midY - 8 - padY, labelWidth + padX * 2, 16 + padY * 2, 4);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#262626';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, midX, midY);
    }

    for (const s of definition.states) {
      this.drawStateStatic(ctx, s);
    }
  }

  getEdgePointStatic(from, to) {
    const cx1 = from.x + STATE_WIDTH / 2;
    const cy1 = from.y + STATE_HEIGHT / 2;
    const cx2 = to.x + STATE_WIDTH / 2;
    const cy2 = to.y + STATE_HEIGHT / 2;
    const angle = Math.atan2(cy2 - cy1, cx2 - cx1);
    const hw = STATE_WIDTH / 2;
    const hh = STATE_HEIGHT / 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let scale;
    if (Math.abs(dx) * hh > Math.abs(dy) * hw) {
      scale = hw / Math.abs(dx);
    } else {
      scale = hh / Math.abs(dy);
    }
    return { x: cx1 + dx * scale, y: cy1 + dy * scale };
  }

  drawArrowStatic(ctx, x1, y1, x2, y2, color, dashed, lineWidth = 2) {
    const headLen = 10;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([5, 5]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
  }

  drawStateStatic(ctx, s) {
    const x = s.x, y = s.y, w = STATE_WIDTH, h = STATE_HEIGHT;
    let fillColor = '#ffffff';
    let strokeColor = '#d9d9d9';
    let lineWidth = 2;
    if (s.isFinal) fillColor = '#f6ffed';
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    ctx.moveTo(x + STATE_RADIUS, y);
    ctx.lineTo(x + w - STATE_RADIUS, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + STATE_RADIUS);
    ctx.lineTo(x + w, y + h - STATE_RADIUS);
    ctx.quadraticCurveTo(x + w, y + h, x + w - STATE_RADIUS, y + h);
    ctx.lineTo(x + STATE_RADIUS, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - STATE_RADIUS);
    ctx.lineTo(x, y + STATE_RADIUS);
    ctx.quadraticCurveTo(x, y, x + STATE_RADIUS, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (s.isFinal) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 4 + (STATE_RADIUS - 2), y + 4);
      ctx.lineTo(x + w - 4 - (STATE_RADIUS - 2), y + 4);
      ctx.quadraticCurveTo(x + w - 4, y + 4, x + w - 4, y + 4 + (STATE_RADIUS - 2));
      ctx.lineTo(x + w - 4, y + h - 4 - (STATE_RADIUS - 2));
      ctx.quadraticCurveTo(x + w - 4, y + h - 4, x + w - 4 - (STATE_RADIUS - 2), y + h - 4);
      ctx.lineTo(x + 4 + (STATE_RADIUS - 2), y + h - 4);
      ctx.quadraticCurveTo(x + 4, y + h - 4, x + 4, y + h - 4 - (STATE_RADIUS - 2));
      ctx.lineTo(x + 4, y + 4 + (STATE_RADIUS - 2));
      ctx.quadraticCurveTo(x + 4, y + 4, x + 4 + (STATE_RADIUS - 2), y + 4);
      ctx.closePath();
      ctx.stroke();
    }
    if (s.isInitial) {
      ctx.fillStyle = '#52c41a';
      ctx.beginPath();
      ctx.arc(x - 10, y + h / 2, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a2e';
      ctx.font = '10px sans-serif';
      ctx.fillText('初始', x - 30, y + h / 2 + 3);
    }
    ctx.fillStyle = '#262626';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.name, x + w / 2, y + h / 2);
  }

  async submitPublishTemplate() {
    const machineId = document.getElementById('publish-machine-select').value;
    const description = document.getElementById('publish-description').value.trim();
    const tagsStr = document.getElementById('publish-tags').value.trim();
    const tags = tagsStr ? tagsStr.split(/[,，]/).map(s => s.trim()).filter(Boolean) : [];

    if (!machineId) {
      toast('请选择要发布的状态机', 'error');
      return;
    }

    try {
      const res = await fetch(API_BASE + '/api/templates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId, description, tags })
      });
      if (!res.ok) {
        if (res.status === 409) throw new Error('该状态机已发布为模板，可先删除再重新发布');
        throw new Error((await res.json()).error);
      }
      toast('模板发布成功!', 'success');
      document.getElementById('publish-description').value = '';
      document.getElementById('publish-tags').value = '';
      this.switchTab('browse');
    } catch (e) {
      toast('发布失败: ' + e.message, 'error');
    }
  }

  async cloneTemplate() {
    if (!this.selectedTemplate) return;
    const defaultName = this.selectedTemplate.name + '_copy';
    const name = prompt('请输入克隆后的状态机名称:', defaultName);
    if (name === null) return;

    try {
      const res = await fetch(API_BASE + '/api/templates/' + this.selectedTemplate.id + '/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const newMachine = await res.json();
      toast(`克隆成功! 新状态机: ${newMachine.name}`, 'success');
      this.closeTemplateMarket();
      await this.loadMachines();
      await this.loadMachine(newMachine.id);
    } catch (e) {
      toast('克隆失败: ' + e.message, 'error');
    }
  }

  async deleteTemplate() {
    if (!this.selectedTemplate) return;
    if (!confirm('确定要删除此模板吗？删除后无法恢复。')) return;

    try {
      const res = await fetch(API_BASE + '/api/templates/' + this.selectedTemplate.id, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast('模板已删除', 'success');
      this.showTemplateList();
      await this.loadTemplates();
    } catch (e) {
      toast('删除失败: ' + e.message, 'error');
    }
  }
  
  getCanvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  
  onDoubleClick(e) {
    if (!this.isDesignMode) return;
    const pos = this.getCanvasPos(e);
    
    const existingState = this.findStateAt(pos.x, pos.y);
    if (existingState) return;
    
    const hitTransition = this.findTransitionAt(pos.x, pos.y);
    if (hitTransition) return;
    
    const id = uid();
    this.states.push({
      id,
      name: '状态' + (this.states.length + 1),
      isInitial: this.states.length === 0,
      isFinal: false,
      x: pos.x - STATE_WIDTH / 2,
      y: pos.y - STATE_HEIGHT / 2
    });
    
    this.selectState(id);
    this.resizeCanvas();
  }
  
  onMouseDown(e) {
    const pos = this.getCanvasPos(e);
    
    if (this.isDesignMode) {
      const state = this.findStateAt(pos.x, pos.y);
      if (state) {
        const edge = this.isNearEdge(pos, state);
        if (edge) {
          this.creatingEdge = true;
          this.edgeFrom = state.id;
          this.edgeTo = { x: pos.x, y: pos.y };
          return;
        }
        this.draggingNode = state;
        this.dragOffset = { x: pos.x - state.x, y: pos.y - state.y };
        this.selectState(state.id);
        return;
      }
    }
    
    const transition = this.findTransitionAt(pos.x, pos.y);
    if (transition) {
      this.selectTransition(transition.id);
      return;
    }
    
    this.clearSelection();
  }
  
  onMouseMove(e) {
    const pos = this.getCanvasPos(e);
    
    if (this.draggingNode && this.isDesignMode) {
      this.draggingNode.x = pos.x - this.dragOffset.x;
      this.draggingNode.y = pos.y - this.dragOffset.y;
      return;
    }
    
    if (this.creatingEdge) {
      this.edgeTo = { x: pos.x, y: pos.y };
    }
    
    this.canvas.style.cursor = this.getCursorAt(pos.x, pos.y);
  }
  
  onMouseUp(e) {
    const pos = this.getCanvasPos(e);
    
    if (this.creatingEdge && this.isDesignMode) {
      const target = this.findStateAt(pos.x, pos.y);
      if (target && target.id !== this.edgeFrom) {
        this.createTransition(this.edgeFrom, target.id);
      }
      this.creatingEdge = false;
      this.edgeFrom = null;
      this.edgeTo = null;
      return;
    }
    
    this.draggingNode = null;
  }
  
  onClick(e) {
  }
  
  getCursorAt(x, y) {
    if (!this.isDesignMode) return 'default';
    const state = this.findStateAt(x, y);
    if (state) {
      if (this.isNearEdge({ x, y }, state)) return 'crosshair';
      return 'move';
    }
    if (this.findTransitionAt(x, y)) return 'pointer';
    return 'default';
  }
  
  findStateAt(x, y) {
    for (let i = this.states.length - 1; i >= 0; i--) {
      const s = this.states[i];
      if (x >= s.x && x <= s.x + STATE_WIDTH && y >= s.y && y <= s.y + STATE_HEIGHT) {
        return s;
      }
    }
    return null;
  }
  
  isNearEdge(pos, state) {
    const cx = state.x + STATE_WIDTH / 2;
    const cy = state.y + STATE_HEIGHT / 2;
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    const distSq = dx * dx + dy * dy;
    const threshold = Math.min(STATE_WIDTH, STATE_HEIGHT) / 2;
    return distSq > (threshold - 15) * (threshold - 15) && 
           distSq < (threshold + 10) * (threshold + 10);
  }
  
  findTransitionAt(x, y) {
    for (const t of this.transitions) {
      const from = this.states.find(s => s.id === t.sourceStateId);
      const to = this.states.find(s => s.id === t.targetStateId);
      if (!from || !to) continue;
      const p1 = this.getEdgePoint(from, to);
      const p2 = this.getEdgePoint(to, from);
      const dist = this.pointToLineDistance(x, y, p1.x, p1.y, p2.x, p2.y);
      if (dist < 8) return t;
    }
    return null;
  }
  
  pointToLineDistance(px, py, x1, y1, x2, y2) {
    const A = px - x1;
    const B = py - y1;
    const C = x2 - x1;
    const D = y2 - y1;
    const dot = A * C + B * D;
    const lenSq = C * C + D * D;
    let param = -1;
    if (lenSq !== 0) param = dot / lenSq;
    let xx, yy;
    if (param < 0) { xx = x1; yy = y1; }
    else if (param > 1) { xx = x2; yy = y2; }
    else { xx = x1 + param * C; yy = y1 + param * D; }
    const dx = px - xx;
    const dy = py - yy;
    return Math.sqrt(dx * dx + dy * dy);
  }
  
  getEdgePoint(from, to) {
    const cx1 = from.x + STATE_WIDTH / 2;
    const cy1 = from.y + STATE_HEIGHT / 2;
    const cx2 = to.x + STATE_WIDTH / 2;
    const cy2 = to.y + STATE_HEIGHT / 2;
    const angle = Math.atan2(cy2 - cy1, cx2 - cx1);
    const hw = STATE_WIDTH / 2;
    const hh = STATE_HEIGHT / 2;
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let scale;
    if (Math.abs(dx) * hh > Math.abs(dy) * hw) {
      scale = hw / Math.abs(dx);
    } else {
      scale = hh / Math.abs(dy);
    }
    return { x: cx1 + dx * scale, y: cy1 + dy * scale };
  }
  
  createTransition(fromId, toId) {
    const id = uid();
    this.transitions.push({
      id,
      sourceStateId: fromId,
      targetStateId: toId,
      event: 'event',
      guard: ''
    });
    this.selectTransition(id);
  }
  
  selectState(id) {
    this.selectedNode = id;
    this.selectedTransition = null;
    this.showStateEditor(id);
  }
  
  selectTransition(id) {
    this.selectedTransition = id;
    this.selectedNode = null;
    this.showTransitionEditor(id);
  }
  
  clearSelection() {
    this.selectedNode = null;
    this.selectedTransition = null;
    document.getElementById('edit-section').style.display = 'none';
  }
  
  showStateEditor(id) {
    const state = this.states.find(s => s.id === id);
    if (!state) return;
    const section = document.getElementById('edit-section');
    const panel = document.getElementById('edit-panel');
    section.style.display = 'block';
    panel.innerHTML = `
      <div class="form-group">
        <label>节点名称</label>
        <input type="text" id="edit-name" value="${state.name}">
      </div>
      <label class="form-check">
        <input type="checkbox" id="edit-initial" ${state.isInitial ? 'checked' : ''}>
        设为初始状态
      </label>
      <label class="form-check">
        <input type="checkbox" id="edit-final" ${state.isFinal ? 'checked' : ''}>
        设为终态
      </label>
      <div class="btn-row">
        <button class="btn btn-sm btn-primary" id="edit-save">保存</button>
        <button class="btn btn-sm btn-danger" id="edit-delete">删除节点</button>
      </div>
    `;
    document.getElementById('edit-save').onclick = () => {
      state.name = document.getElementById('edit-name').value || '状态';
      const initial = document.getElementById('edit-initial').checked;
      if (initial) this.states.forEach(s => s.isInitial = false);
      state.isInitial = initial;
      state.isFinal = document.getElementById('edit-final').checked;
      toast('节点已更新', 'success');
    };
    document.getElementById('edit-delete').onclick = () => {
      this.states = this.states.filter(s => s.id !== id);
      this.transitions = this.transitions.filter(t => t.sourceStateId !== id && t.targetStateId !== id);
      this.clearSelection();
      toast('节点已删除', 'success');
    };
  }
  
  showTransitionEditor(id) {
    if (!this.isDesignMode) {
      const section = document.getElementById('edit-section');
      section.style.display = 'none';
      return;
    }
    const t = this.transitions.find(tr => tr.id === id);
    if (!t) return;
    const section = document.getElementById('edit-section');
    const panel = document.getElementById('edit-panel');
    section.style.display = 'block';
    panel.innerHTML = `
      <div class="form-group">
        <label>事件名称</label>
        <input type="text" id="edit-event" value="${t.event || ''}" placeholder="如 approve">
      </div>
      <div class="form-group">
        <label>守卫表达式 (可选)</label>
        <input type="text" id="edit-guard" value="${t.guard || ''}" placeholder="如 payload.amount > 1000">
        <small style="color:#8c8c8c;margin-top:4px;">支持: ==,!=,>,<,>=,<= 命名空间: payload, context</small>
      </div>
      <div class="btn-row">
        <button class="btn btn-sm btn-primary" id="edit-save">保存</button>
        <button class="btn btn-sm btn-danger" id="edit-delete">删除转换</button>
      </div>
    `;
    document.getElementById('edit-save').onclick = () => {
      t.event = document.getElementById('edit-event').value || 'event';
      t.guard = document.getElementById('edit-guard').value;
      toast('转换已更新', 'success');
    };
    document.getElementById('edit-delete').onclick = () => {
      this.transitions = this.transitions.filter(tr => tr.id !== id);
      this.clearSelection();
      toast('转换已删除', 'success');
    };
  }
  
  newMachine() {
    this.currentName = '未命名状态机';
    this.states = [];
    this.transitions = [];
    this.isDesignMode = true;
    this.selectedMachine = null;
    this.instances = [];
    this.selectedInstance = null;
    this.instanceStates = new Map();
    this.violations = [];
    this.selectedViolationId = null;
    this.highlightedStateId = null;
    this.stopViolationStatsTimer();
    this.clearSelection();
    this.updateCurrentName();
    this.updateInstancePanel();
    this.updateViolationPanel();
    this.disconnectWS();
    toast('已创建新状态机', 'info');
  }
  
  updateCurrentName() {
    document.getElementById('current-name').textContent = this.currentName + 
      (this.isDesignMode ? ' (设计模式)' : ' (运行模式)');
  }
  
  updateInstancePanel() {
    const controls = document.getElementById('instance-controls');
    const hint = document.getElementById('no-instance-hint');
    if (this.selectedMachine) {
      controls.style.display = 'block';
      hint.style.display = 'none';
      this.renderInstanceList();
    } else {
      controls.style.display = 'none';
      hint.style.display = 'block';
      document.getElementById('instance-detail').innerHTML = '';
    }
  }
  
  renderInstanceList() {
    const container = document.getElementById('instance-list');
    if (this.instances.length === 0) {
      container.innerHTML = '<span style="color:#8c8c8c;font-size:12px;">暂无实例</span>';
      return;
    }
    
    const currentMachine = this.machines.find(m => m.id === this.selectedMachine);
    const latestVersion = currentMachine ? this.latestVersions.get(currentMachine.name) : null;
    
    container.innerHTML = this.instances.map(inst => {
      const state = this.states.find(s => s.id === inst.currentStateId);
      const stateName = state ? state.name : inst.currentStateId;
      const cls = 'instance-chip' + 
        (inst.id === this.selectedInstance ? ' active' : '') +
        (inst.isFinal ? ' final' : '') +
        (inst.isFrozen ? ' frozen' : '');
      
      let versionBadge = '';
      if (inst.machineVersion !== undefined && latestVersion !== null) {
        if (inst.machineVersion < latestVersion) {
          versionBadge = `<span class="instance-version-badge outdated">v${inst.machineVersion}</span>`;
        } else {
          versionBadge = `<span class="instance-version-badge latest">v${inst.machineVersion}</span>`;
        }
      }

      let takeoverBadge = '';
      if (inst.isFrozen) {
        const operatorName = inst.activeTakeover ? inst.activeTakeover.operatorName : '冻结';
        takeoverBadge = `<span class="badge badge-danger" style="margin-left:4px;">❄️ ${operatorName}</span>`;
      }
      
      return `<div class="${cls}" data-id="${inst.id}">
        ${inst.id.slice(0, 8)}… [${stateName}]${versionBadge}${takeoverBadge}
      </div>`;
    }).join('');
    container.querySelectorAll('.instance-chip').forEach(el => {
      el.onclick = () => this.selectInstance(el.dataset.id);
    });
  }
  
  async selectInstance(id) {
    this.selectedInstance = id;
    this.renderInstanceList();
    try {
      const res = await fetch(API_BASE + '/api/instances/' + id);
      const data = await res.json();
      this.renderInstanceDetail(data);
    } catch (e) {
      toast('加载实例详情失败', 'error');
    }
  }
  
  renderInstanceDetail(inst) {
    const detail = document.getElementById('instance-detail');
    const currentState = this.states.find(s => s.id === inst.currentStateId);
    const stateName = currentState ? currentState.name : inst.currentStateId;
    
    let versionInfo = '';
    if (inst.machineVersion !== undefined && inst.machineName) {
      const latestVersion = this.latestVersions.get(inst.machineName);
      const isLatest = latestVersion && inst.machineVersion >= latestVersion;
      versionInfo = `
        <div>
          <strong>版本:</strong> 
          <span class="instance-version-badge ${isLatest ? 'latest' : 'outdated'}">v${inst.machineVersion}</span>
          ${!isLatest ? `<span style="color:#fa8c16;font-size:11px;margin-left:6px;">⚠️ 不是最新版本 (最新: v${latestVersion})</span>` : ''}
        </div>
      `;
    }
    
    let migrationHistoryHtml = '';
    if (inst.migrationHistory && inst.migrationHistory.length > 0) {
      migrationHistoryHtml = '<div style="margin-top:10px;"><strong>版本迁移历史:</strong><div>';
      for (const m of inst.migrationHistory) {
        const statusBadge = m.status === 'completed' 
          ? '<span class="result-status status-success" style="font-size:10px;">成功</span>'
          : '<span class="result-status status-failed" style="font-size:10px;">失败</span>';
        migrationHistoryHtml += `<div class="migration-history-item">
          <div class="migration-history-title">
            v${m.sourceVersion} → v${m.targetVersion} ${statusBadge}
          </div>
          <div class="migration-history-detail">
            操作人: ${escapeHtml(m.operator)}<br>
            时间: ${new Date(m.createdAt).toLocaleString()}
            ${m.errorMessage ? `<br><span style="color:#ff4d4f;">失败原因: ${escapeHtml(m.errorMessage)}</span>` : ''}
            ${m.warnings && m.warnings.length > 0 ? `<br><span style="color:#d48806;">警告: ${m.warnings.map(w => escapeHtml(w)).join('; ')}</span>` : ''}
          </div>
        </div>`;
      }
      migrationHistoryHtml += '</div></div>';
    }
    
    let historyHtml = '';
    if (inst.history && inst.history.length > 0) {
      historyHtml = '<div style="margin-top:10px;"><strong>流转历史:</strong><div>';
      for (const h of inst.history) {
        const fromS = this.states.find(s => s.id === h.fromStateId);
        const toS = this.states.find(s => s.id === h.toStateId);
        const fromName = fromS ? fromS.name : h.fromStateId;
        const toName = toS ? toS.name : h.toStateId;
        
        if (h.event === '__version_migration__') {
          const payload = h.payload || {};
          historyHtml += `<div class="history-item" style="background:#f0f5ff;border-left:3px solid #1890ff;">
            <span style="color:#8c8c8c;">${new Date(h.createdAt).toLocaleString()}</span><br>
            <span style="color:#1890ff;font-weight:600;">🔄 版本迁移</span>: v${payload.fromVersion} → v${payload.toVersion}
            <span style="color:#8c8c8c;font-size:11px;">(${h.triggeredBy})</span>
            ${payload.warnings && payload.warnings.length > 0 ? `<div style="color:#d48806;">警告: ${payload.warnings.map(w => escapeHtml(w)).join('; ')}</div>` : ''}
          </div>`;
        } else {
          historyHtml += `<div class="history-item">
            <span style="color:#8c8c8c;">${new Date(h.createdAt).toLocaleString()}</span><br>
            <span style="color:#1890ff;">${fromName}</span> → 
            <strong>[${escapeHtml(h.event)}]</strong> → 
            <span style="color:#52c41a;">${toName}</span>
            <span style="color:#8c8c8c;font-size:11px;">(${escapeHtml(h.triggeredBy || 'user')})</span>
            ${h.payload ? `<div style="color:#8c8c8c;">payload: ${JSON.stringify(h.payload)}</div>` : ''}
          </div>`;
        }
      }
      historyHtml += '</div></div>';
    }
    
    let freezeInfoHtml = '';
    if (inst.freezeInfo && inst.freezeInfo.isFrozen) {
      freezeInfoHtml = `
        <div style="margin-top:10px;padding:12px;background:#fff1f0;border:1px solid #ffa39e;border-radius:6px;">
          <div style="color:#cf1322;font-weight:600;margin-bottom:6px;">❄️ 实例已冻结</div>
          <div style="font-size:12px;color:#595959;">
            冻结人: ${escapeHtml(inst.freezeInfo.frozenBy)}<br>
            冻结时间: ${new Date(inst.freezeInfo.frozenAt).toLocaleString()}
            ${inst.freezeInfo.reason ? `<br>原因: ${escapeHtml(inst.freezeInfo.reason)}` : ''}
          </div>
          ${inst.activeTakeover ? `
            <div style="margin-top:8px;font-size:12px;color:#d46b08;">
              👤 当前接管人: <strong>${escapeHtml(inst.activeTakeover.operatorName)}</strong>
            </div>
          ` : ''}
          <div style="margin-top:8px;">
            <button class="btn btn-sm btn-primary" onclick="app.openTakeoverForInstance('${inst.id}')">🚨 进入接管工作台</button>
          </div>
        </div>
      `;
    } else {
      freezeInfoHtml = `
        <div style="margin-top:10px;">
          <button class="btn btn-sm" style="background:#d4380d;" onclick="app.freezeInstance('${inst.id}')">❄️ 冻结并接管</button>
        </div>
      `;
    }

    let pendingEventsHtml = '';
    if (inst.pendingEvents && inst.pendingEvents.length > 0) {
      pendingEventsHtml = `
        <div style="margin-top:10px;">
          <strong>排队事件 (${inst.pendingEvents.length}):</strong>
          <div style="max-height:100px;overflow-y:auto;">
            ${inst.pendingEvents.map(e => `
              <div style="font-size:11px;padding:4px 8px;background:#fffbe6;border-left:2px solid #faad14;margin-top:4px;border-radius:2px;">
                <strong>${escapeHtml(e.eventName)}</strong> - ${new Date(e.receivedAt).toLocaleTimeString()}
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    let violationsHtml = '';
    if (inst.recentViolations && inst.recentViolations.length > 0) {
      violationsHtml = `
        <div style="margin-top:10px;">
          <strong>最近违规 (${inst.recentViolations.length}):</strong>
          <div style="max-height:120px;overflow-y:auto;">
            ${inst.recentViolations.slice(0, 5).map(v => `
              <div style="font-size:11px;padding:6px 8px;background:#fff1f0;border-left:2px solid #ff4d4f;margin-top:4px;border-radius:2px;">
                <div style="color:#cf1322;font-weight:600;">${escapeHtml(v.policyName || '违规')}</div>
                <div style="color:#595959;">${escapeHtml(v.reason)}</div>
                <div style="color:#8c8c8c;font-size:10px;">${new Date(v.attemptedAt).toLocaleString()}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    detail.innerHTML = `
      <div><strong>实例ID:</strong> ${inst.id}</div>
      <div><strong>当前状态:</strong> <span style="color:#1890ff;font-weight:600;">${stateName}</span>${inst.isFinal ? ' <span class="badge badge-active">终态</span>' : ''}</div>
      ${versionInfo}
      <div><strong>创建时间:</strong> ${new Date(inst.createdAt).toLocaleString()}</div>
      <div><strong>上下文:</strong> <code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;">${JSON.stringify(inst.context)}</code></div>
      ${freezeInfoHtml}
      ${pendingEventsHtml}
      ${violationsHtml}
      ${migrationHistoryHtml}
      ${historyHtml}
    `;
  }
  
  validateMachine() {
    if (this.states.length < 2) return '至少需要2个状态节点';
    const initial = this.states.filter(s => s.isInitial);
    if (initial.length !== 1) return '必须有且仅有一个初始状态';
    const final = this.states.filter(s => s.isFinal);
    if (final.length < 1) return '至少需要一个终态';
    if (this.transitions.length < 1) return '至少需要一个转换箭头';
    return null;
  }
  
  async publishMachine() {
    const error = this.validateMachine();
    if (error) {
      toast(error, 'error');
      return;
    }
    const name = prompt('请输入状态机名称:', this.currentName === '未命名状态机' ? '新状态机' : this.currentName);
    if (!name) return;
    
    try {
      const res = await fetch(API_BASE + '/api/machines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          states: this.states.map(s => ({
            id: s.id, name: s.name, isInitial: s.isInitial, isFinal: s.isFinal, x: s.x, y: s.y
          })),
          transitions: this.transitions.map(t => ({
            id: t.id, sourceStateId: t.sourceStateId, targetStateId: t.targetStateId,
            event: t.event, guard: t.guard
          }))
        })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast('状态机已发布!', 'success');
      this.currentName = name;
      this.updateCurrentName();
      await this.loadMachines();
    } catch (e) {
      toast('发布失败: ' + e.message, 'error');
    }
  }
  
  async loadMachines() {
    try {
      const [resFlat, resGrouped] = await Promise.all([
        fetch(API_BASE + '/api/machines'),
        fetch(API_BASE + '/api/machines/grouped')
      ]);
      this.machines = await resFlat.json();
      this.machineGroups = await resGrouped.json();
      
      this.latestVersions.clear();
      for (const group of this.machineGroups) {
        this.latestVersions.set(group.name, group.latestVersion);
      }
      
      this.renderMachineList();
    } catch (e) {
      console.error(e);
    }
  }
  
  renderMachineList() {
    const list = document.getElementById('machine-list');
    if (this.machineGroups.length === 0) {
      list.innerHTML = '<div style="color:#8c8c8c;font-size:12px;">暂无已发布状态机</div>';
      return;
    }
    
    list.innerHTML = this.machineGroups.map(group => {
      const isExpanded = this.expandedGroups.has(group.name);
      return `
        <div class="machine-group">
          <div class="machine-group-header" data-group="${escapeHtml(group.name)}">
            <div class="machine-group-title">${escapeHtml(group.name)}</div>
            <div class="machine-group-meta">
              <span class="machine-group-badge badge-version">v${group.latestVersion}</span>
              <span class="machine-group-badge badge-latest">最新</span>
              <span class="machine-group-badge" style="background:#1890ff;color:white;">${group.totalActiveInstances} 运行中</span>
            </div>
          </div>
          <div class="machine-group-content ${isExpanded ? 'expanded' : ''}" data-content="${escapeHtml(group.name)}">
            ${group.machines.map(m => {
              const isLatest = m.version === group.latestVersion;
              const hasActiveInstances = m.activeInstances > 0 && !isLatest;
              return `
                <div class="machine-version-item ${this.selectedMachine === m.id ? 'active' : ''} ${!isLatest ? 'outdated' : ''}" data-id="${escapeHtml(m.id)}">
                  <div class="version-info">
                    <div class="version-name">
                      v${m.version}
                      ${isLatest ? '<span class="instance-version-badge latest">最新</span>' : ''}
                      ${hasActiveInstances ? '<span class="instance-version-badge outdated">有旧版本实例</span>' : ''}
                    </div>
                    <div class="version-meta">
                      ${new Date(m.createdAt).toLocaleString()} · ${m.activeInstances} 运行中
                    </div>
                  </div>
                  <div class="version-actions">
                    ${hasActiveInstances ? `<button class="btn-migrate" data-migrate="${escapeHtml(m.id)}" data-name="${escapeHtml(group.name)}">迁移实例</button>` : ''}
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');
    
    list.querySelectorAll('.machine-group-header').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        const groupName = el.dataset.group;
        if (this.expandedGroups.has(groupName)) {
          this.expandedGroups.delete(groupName);
        } else {
          this.expandedGroups.add(groupName);
        }
        this.renderMachineList();
      };
    });
    
    list.querySelectorAll('.machine-version-item').forEach(el => {
      el.onclick = (e) => {
        if (e.target.closest('.btn-migrate')) return;
        this.loadMachine(el.dataset.id);
      };
    });
    
    list.querySelectorAll('.btn-migrate').forEach(el => {
      el.onclick = (e) => {
        e.stopPropagation();
        this.openMigrationModal(el.dataset.migrate, el.dataset.name);
      };
    });
  }
  
  async loadMachine(id) {
    try {
      const res = await fetch(API_BASE + '/api/machines/' + id);
      const m = await res.json();
      this.selectedMachine = id;
      this.currentName = m.name;
      this.states = m.definition.states.map((s, i) => ({
        ...s,
        x: typeof s.x === 'number' ? s.x : (100 + i * 180 + Math.random() * 40),
        y: typeof s.y === 'number' ? s.y : (100 + (i % 2) * 120 + Math.random() * 40)
      }));
      this.transitions = m.definition.transitions || [];
      this.isDesignMode = false;
      this.clearSelection();
      this.updateCurrentName();
      this.renderMachineList();

      setTimeout(() => {
        this.resizeCanvas();
        const wrapper = this.canvas.parentElement;
        if (wrapper) {
          wrapper.scrollLeft = 0;
          wrapper.scrollTop = 0;
        }
      }, 0);

      await this.loadInstances();
      this.updateInstancePanel();
      this.violations = [];
      this.selectedViolationId = null;
      this.highlightedStateId = null;
      this.updateViolationPanel();
      this.connectWS(id);
      this.startViolationStatsTimer();
      this.fetchViolationStats();
    } catch (e) {
      toast('加载状态机失败', 'error');
    }
  }
  
  async loadInstances() {
    if (!this.selectedMachine) return;
    try {
      const res = await fetch(API_BASE + '/api/machines/' + this.selectedMachine + '/instances');
      this.instances = await res.json();
      this.countInstanceState();
      this.renderInstanceList();
    } catch (e) {
      console.error(e);
    }
  }
  
  countInstanceState() {
    this.instanceStates = new Map();
    for (const inst of this.instances) {
      if (inst.isFinal) continue;
      const count = this.instanceStates.get(inst.currentStateId) || 0;
      this.instanceStates.set(inst.currentStateId, count + 1);
    }
  }
  
  async createInstance() {
    if (!this.selectedMachine) return;
    try {
      const res = await fetch(API_BASE + '/api/machines/' + this.selectedMachine + '/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) throw new Error('创建失败');
      toast('实例已创建', 'success');
      await this.loadInstances();
      await this.loadMachines();
    } catch (e) {
      toast('创建实例失败: ' + e.message, 'error');
    }
  }
  
  async sendEvent() {
    if (!this.selectedInstance) {
      toast('请先选择一个实例', 'error');
      return;
    }
    const event = document.getElementById('event-name').value.trim();
    const payloadStr = document.getElementById('event-payload').value.trim() || '{}';
    if (!event) {
      toast('请输入事件名称', 'error');
      return;
    }
    let payload = {};
    try {
      payload = JSON.parse(payloadStr);
    } catch (e) {
      toast('payload 不是有效的JSON', 'error');
      return;
    }
    try {
      const res = await fetch(API_BASE + '/api/instances/' + this.selectedInstance + '/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event, payload })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }
      toast('事件发送成功!', 'success');
    } catch (e) {
      toast('发送失败: ' + e.message, 'error');
    }
  }
  
  connectWS(machineId) {
    this.disconnectWS();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(proto + '//localhost:3000');
    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({ type: 'subscribe', machineId }));
    };
    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        this.handleWSMessage(msg);
      } catch (e) {
        console.error(e);
      }
    };
    this.ws.onclose = () => {
      setTimeout(() => { if (this.selectedMachine) this.connectWS(this.selectedMachine); }, 3000);
    };
  }
  
  disconnectWS() {
    this.stopViolationStatsTimer();
    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }
  }
  
  handleWSMessage(msg) {
    if (msg.type === 'transition') {
      const transition = this.transitions.find(
        t => t.sourceStateId === msg.fromStateId && t.targetStateId === msg.toStateId && t.event === msg.event
      );
      if (transition) {
        this.flashingArrows.set(transition.id, Date.now());
      }
      
      const idx = this.instances.findIndex(i => i.id === msg.instanceId);
      if (idx >= 0) {
        this.instances[idx].currentStateId = msg.toStateId;
        if (msg.isFinal !== undefined) {
          this.instances[idx].isFinal = msg.isFinal;
        }
      }
      this.countInstanceState();
      this.renderInstanceList();
      
      if (this.selectedInstance === msg.instanceId) {
        this.selectInstance(msg.instanceId);
      }
      
      this.loadMachines();
    } else if (msg.type === 'compliance_alert') {
      this.addViolation(msg);
    } else if (msg.type === 'version_migration' || msg.type === 'version_migration_out') {
      if (msg.type === 'version_migration_out') {
        const idx = this.instances.findIndex(i => i.id === msg.instanceId);
        if (idx >= 0) {
          this.instances.splice(idx, 1);
          this.countInstanceState();
          this.renderInstanceList();
          if (this.selectedInstance === msg.instanceId) {
            this.selectedInstance = null;
            document.getElementById('instance-detail').innerHTML = '';
          }
        }
      } else if (msg.type === 'version_migration' && this.selectedMachine === msg.targetMachineId) {
        this.loadInstances();
      }
      this.loadMachines();
    } else if (msg.type === 'takeover_started') {
      toast(`🚨 实例 ${msg.instanceId.slice(0, 8)}… 已被 ${msg.operatorName} 接管`, 'warning');
      this.updateInstanceFrozenStatus(msg.instanceId, true, msg.operatorName);
      if (this.currentTakeoverSession || document.getElementById('takeover-modal').style.display === 'flex') {
        this.loadTakeoverDashboard();
      }
    } else if (msg.type === 'takeover_ended') {
      toast(`✅ 实例 ${msg.instanceId.slice(0, 8)}… 接管已结束`, 'success');
      this.updateInstanceFrozenStatus(msg.instanceId, false);
      if (this.currentTakeoverSession && this.currentTakeoverSession.instanceId === msg.instanceId) {
        this.currentTakeoverSession = null;
        this.showTakeoverDashboard();
      }
      if (document.getElementById('takeover-modal').style.display === 'flex') {
        this.loadTakeoverDashboard();
      }
    } else if (msg.type === 'takeover_action') {
      if (this.currentTakeoverSession && this.currentTakeoverSession.id === msg.sessionId) {
        this.loadTakeoverSessionDetail(msg.sessionId);
      }
      if (this.selectedInstance === msg.instanceId) {
        this.selectInstance(msg.instanceId);
      }
      if (document.getElementById('takeover-modal').style.display === 'flex') {
        this.loadTakeoverDashboard();
      }
    } else if (msg.type === 'instance_frozen') {
      toast(`❄️ 实例已被 ${msg.frozenByName} 冻结`, 'warning');
      this.updateInstanceFrozenStatus(msg.instanceId, true, msg.frozenByName);
    } else if (msg.type === 'instance_unfrozen') {
      toast(`☀️ 实例已被 ${msg.unfrozenByName} 解冻`, 'success');
      this.updateInstanceFrozenStatus(msg.instanceId, false);
    } else if (msg.type === 'event_queued') {
      toast(`📥 事件 "${msg.event}" 已排队等待`, 'info');
      if (this.currentTakeoverSession && this.currentTakeoverSession.instanceId === msg.instanceId) {
        this.loadTakeoverSessionDetail(this.currentTakeoverSession.id);
      }
    }
  }
  
  updateViolationPanel() {
    const section = document.getElementById('violation-section');
    if (this.selectedMachine && !this.isDesignMode) {
      section.style.display = 'block';
    } else {
      section.style.display = 'none';
    }
    this.renderViolationList();
  }
  
  addViolation(violation) {
    const violationWithId = {
      ...violation,
      id: 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      isNew: true
    };
    
    this.violations.unshift(violationWithId);
    
    if (this.violations.length > 100) {
      this.violations = this.violations.slice(0, 100);
    }
    
    this.renderViolationList();
    this.showFlashBadge();
    this.fetchViolationStats();
    
    setTimeout(() => {
      const v = this.violations.find(v => v.id === violationWithId.id);
      if (v) v.isNew = false;
      this.renderViolationList();
    }, 1000);
    
    toast(`🚨 合规违规: ${violation.policyName}`, 'error');
  }
  
  renderViolationList() {
    const container = document.getElementById('violation-list');
    
    if (this.violations.length === 0) {
      container.innerHTML = '<div class="violation-empty">暂无实时违规记录</div>';
      return;
    }
    
    container.innerHTML = this.violations.map(v => {
      const state = this.states.find(s => s.id === v.currentStateId);
      const stateName = state ? state.name : (v.currentStateId || '未知');
      const timeStr = new Date(v.attemptedAt).toLocaleString();
      const newClass = v.isNew ? ' new-violation' : '';
      const activeClass = this.selectedViolationId === v.id ? ' active' : '';
      
      return `
        <div class="violation-item${newClass}${activeClass}" data-id="${escapeHtml(v.id)}">
          <div class="violation-header">
            <span class="violation-instance">${escapeHtml(v.instanceId.slice(0, 10))}…</span>
            <span class="violation-time">${escapeHtml(timeStr)}</span>
          </div>
          <span class="violation-policy">${escapeHtml(v.policyName)}</span>
          <div class="violation-event">
            拦截事件: <strong>${escapeHtml(v.eventName || '未知')}</strong>
          </div>
          <div class="violation-event">
            当前状态: <strong>${escapeHtml(stateName)}</strong>
          </div>
          <div class="violation-reason">${escapeHtml(v.reason)}</div>
        </div>
      `;
    }).join('');
    
    container.querySelectorAll('.violation-item').forEach(el => {
      el.onclick = () => this.selectViolation(el.dataset.id);
    });
    
    if (this.violations.length > 0 && this.violations[0].isNew) {
      container.scrollTop = 0;
    }
  }
  
  showFlashBadge() {
    const badge = document.getElementById('violation-flash-badge');
    badge.style.display = 'inline-block';
    
    if (this.flashBadgeTimer) {
      clearTimeout(this.flashBadgeTimer);
    }
    
    this.flashBadgeTimer = setTimeout(() => {
      badge.style.display = 'none';
    }, 3000);
  }
  
  clearViolations() {
    this.violations = [];
    this.selectedViolationId = null;
    this.highlightedStateId = null;
    this.renderViolationList();
    toast('违规记录已清空', 'info');
  }
  
  selectViolation(violationId) {
    this.selectedViolationId = violationId;
    const violation = this.violations.find(v => v.id === violationId);
    
    if (violation) {
      const instance = this.instances.find(inst => inst.id === violation.instanceId);
      if (instance) {
        this.highlightedStateId = instance.currentStateId;
      } else {
        this.highlightedStateId = violation.currentStateId;
      }
      this.renderViolationList();
      
      setTimeout(() => {
        this.highlightedStateId = null;
      }, 3000);
    }
  }
  
  async fetchViolationStats() {
    if (!this.selectedMachine || this.isDesignMode) return;
    
    try {
      const res = await fetch(API_BASE + '/api/machines/' + this.selectedMachine + '/compliance/violations/stats');
      const stats = await res.json();
      this.updateStatsDisplay(stats);
    } catch (e) {
      console.error('Failed to fetch violation stats:', e);
    }
  }
  
  updateStatsDisplay(stats) {
    document.getElementById('stat-total').textContent = stats.totalViolations;
    document.getElementById('stat-frequency').textContent = stats.lastMinuteFrequency + '/分钟';
    document.getElementById('stat-top-policy').textContent = stats.topPolicy 
      ? `${stats.topPolicy.policyName} (${stats.topPolicy.count}次)` 
      : '-';
  }
  
  startViolationStatsTimer() {
    this.stopViolationStatsTimer();
    this.violationStatsTimer = setInterval(() => {
      this.fetchViolationStats();
    }, 5000);
  }
  
  stopViolationStatsTimer() {
    if (this.violationStatsTimer) {
      clearInterval(this.violationStatsTimer);
      this.violationStatsTimer = null;
    }
    if (this.flashBadgeTimer) {
      clearTimeout(this.flashBadgeTimer);
      this.flashBadgeTimer = null;
    }
  }
  
  render() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    
    for (const t of this.transitions) {
      this.drawTransition(t);
    }
    
    if (this.creatingEdge && this.edgeFrom && this.edgeTo) {
      const from = this.states.find(s => s.id === this.edgeFrom);
      if (from) {
        const target = this.findStateAt(this.edgeTo.x, this.edgeTo.y);
        let end = this.edgeTo;
        if (target) {
          end = this.getEdgePoint(target, from);
        }
        const start = this.getEdgePoint(from, target || { x: this.edgeTo.x, y: this.edgeTo.y });
        this.drawArrow(start.x, start.y, end.x, end.y, '#8c8c8c', true);
      }
    }
    
    for (const s of this.states) {
      this.drawState(s);
    }
  }
  
  drawState(s) {
    const ctx = this.ctx;
    const x = s.x, y = s.y, w = STATE_WIDTH, h = STATE_HEIGHT;
    
    const isSelected = this.selectedNode === s.id;
    const isHighlighted = this.highlightedStateId === s.id;
    const instCount = this.instanceStates.get(s.id) || 0;
    
    let fillColor = '#ffffff';
    let strokeColor = '#d9d9d9';
    let lineWidth = 2;
    
    if (s.isFinal) fillColor = '#f6ffed';
    if (isSelected) { strokeColor = '#1890ff'; lineWidth = 3; }
    if (isHighlighted) { 
      strokeColor = '#ff4d4f'; 
      lineWidth = 4;
      fillColor = '#fff1f0';
    }
    if (instCount > 0) fillColor = this.isDesignMode ? fillColor : (isHighlighted ? '#fff1f0' : '#e6f7ff');
    
    ctx.fillStyle = fillColor;
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = lineWidth;
    
    this.roundRect(x, y, w, h, STATE_RADIUS);
    ctx.fill();
    ctx.stroke();
    
    if (s.isFinal) {
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 1;
      this.roundRect(x + 4, y + 4, w - 8, h - 8, STATE_RADIUS - 2);
      ctx.stroke();
    }
    
    if (s.isInitial) {
      ctx.fillStyle = '#52c41a';
      ctx.beginPath();
      ctx.arc(x - 10, y + h / 2, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a2e';
      ctx.font = '10px sans-serif';
      ctx.fillText('初始', x - 30, y + h / 2 + 3);
    }
    
    ctx.fillStyle = '#262626';
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s.name, x + w / 2, y + h / 2);
    
    if (instCount > 0 && !this.isDesignMode) {
      ctx.fillStyle = '#1890ff';
      ctx.beginPath();
      ctx.arc(x + w, y, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.fillText(String(instCount), x + w, y);
    }
  }
  
  drawTransition(t) {
    const ctx = this.ctx;
    const from = this.states.find(s => s.id === t.sourceStateId);
    const to = this.states.find(s => s.id === t.targetStateId);
    if (!from || !to) return;
    
    const p1 = this.getEdgePoint(from, to);
    const p2 = this.getEdgePoint(to, from);
    
    let color = '#8c8c8c';
    let lineWidth = 2;
    if (this.selectedTransition === t.id) { color = '#1890ff'; lineWidth = 3; }
    
    const flashTime = this.flashingArrows.get(t.id);
    if (flashTime) {
      const elapsed = Date.now() - flashTime;
      if (elapsed < 1500) {
        const intensity = 1 - elapsed / 1500;
        color = `rgba(82, 196, 26, ${0.4 + intensity * 0.6})`;
        lineWidth = 3 + intensity * 3;
      } else {
        this.flashingArrows.delete(t.id);
      }
    }
    
    this.drawArrow(p1.x, p1.y, p2.x, p2.y, color, false, lineWidth);
    
    const midX = (p1.x + p2.x) / 2;
    const midY = (p1.y + p2.y) / 2;
    
    const label = t.guard ? `${t.event} [${t.guard}]` : t.event;
    ctx.font = '11px sans-serif';
    const labelWidth = ctx.measureText(label).width;
    const padX = 6, padY = 3;
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(midX - labelWidth / 2 - padX, midY - 8 - padY, labelWidth + padX * 2, 16 + padY * 2, 4);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#262626';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, midY);
  }
  
  drawArrow(x1, y1, x2, y2, color, dashed, lineWidth = 2) {
    const ctx = this.ctx;
    const headLen = 10;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const angle = Math.atan2(dy, dx);
    
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (dashed) ctx.setLineDash([5, 5]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(
      x2 - headLen * Math.cos(angle - Math.PI / 6),
      y2 - headLen * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      x2 - headLen * Math.cos(angle + Math.PI / 6),
      y2 - headLen * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }
  
  roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  async openMigrationModal(sourceMachineId, machineName) {
    const sourceMachine = this.machines.find(m => m.id === sourceMachineId);
    if (!sourceMachine) {
      toast('找不到源状态机', 'error');
      return;
    }

    this.migrationSourceMachine = sourceMachine;
    this.migrationTargetMachineId = null;
    this.migrationSelectedInstances.clear();
    this.migrationCheckResult = null;

    try {
      const [versionsRes, instancesRes] = await Promise.all([
        fetch(API_BASE + '/api/machines/' + encodeURIComponent(machineName) + '/versions'),
        fetch(API_BASE + '/api/machines/' + sourceMachineId + '/instances')
      ]);

      const allVersions = await versionsRes.json();
      const allInstances = await instancesRes.json();

      const targetVersions = allVersions.filter(m => m.id !== sourceMachineId);

      if (targetVersions.length === 0) {
        toast('没有其他版本可供迁移', 'error');
        return;
      }

      this.migrationAllInstances = allInstances.filter(inst => !inst.isFinal);

      const targetSelect = document.getElementById('migration-target-select');
      targetSelect.innerHTML = '<option value="">-- 请选择目标版本 --</option>' +
        targetVersions.map(m => `
          <option value="${escapeHtml(m.id)}">
            v${m.version} ${m.version > sourceMachine.version ? '(更新)' : '(更旧)'} · ${new Date(m.createdAt).toLocaleString()}
          </option>
        `).join('');

      document.getElementById('migration-source-info').innerHTML = `
        <strong>${escapeHtml(sourceMachine.name)}</strong> · v${sourceMachine.version} · ${this.migrationAllInstances.length} 个运行中实例
      `;

      this.renderMigrationInstanceList();
      this.showMigrationStep('select');
      document.getElementById('migration-modal').style.display = 'flex';
    } catch (e) {
      toast('打开迁移对话框失败: ' + e.message, 'error');
    }
  }

  closeMigrationModal() {
    document.getElementById('migration-modal').style.display = 'none';
    this.migrationSourceMachine = null;
    this.migrationTargetMachineId = null;
    this.migrationSelectedInstances.clear();
    this.migrationCheckResult = null;
  }

  showMigrationStep(step) {
    document.getElementById('migration-step-select').style.display = step === 'select' ? 'block' : 'none';
    document.getElementById('migration-step-check').style.display = step === 'check' ? 'block' : 'none';
    document.getElementById('migration-step-execute').style.display = step === 'execute' ? 'block' : 'none';
  }

  onTargetVersionChange(targetMachineId) {
    this.migrationTargetMachineId = targetMachineId || null;
    document.getElementById('btn-check-migration').disabled = !targetMachineId || this.migrationSelectedInstances.size === 0;
  }

  renderMigrationInstanceList() {
    const container = document.getElementById('migration-instance-list');
    const instances = this.migrationAllInstances || [];

    if (instances.length === 0) {
      container.innerHTML = '<div style="text-align:center;color:#8c8c8c;padding:20px;">暂无运行中实例</div>';
      return;
    }

    const selectAllChecked = this.migrationSelectedInstances.size === instances.length;

    container.innerHTML = `
      <div class="select-all-bar">
        <label>
          <input type="checkbox" id="select-all-instances" ${selectAllChecked ? 'checked' : ''}>
          全选 (${this.migrationSelectedInstances.size}/${instances.length})
        </label>
      </div>
      ${instances.map(inst => {
        const state = this.migrationSourceMachine && this.migrationSourceMachine.definition 
          ? this.migrationSourceMachine.definition.states.find(s => s.id === inst.currentStateId)
          : null;
        const stateName = state ? state.name : inst.currentStateId;
        const isSelected = this.migrationSelectedInstances.has(inst.id);
        return `
          <div class="migration-instance-item ${isSelected ? 'selected' : ''}" data-id="${escapeHtml(inst.id)}">
            <input type="checkbox" data-instance="${escapeHtml(inst.id)}" ${isSelected ? 'checked' : ''}>
            <div class="instance-item-info">
              <div class="instance-item-id">${escapeHtml(inst.id)}</div>
              <div class="instance-item-state">当前状态: ${escapeHtml(stateName)}</div>
            </div>
          </div>
        `;
      }).join('')}
    `;

    document.getElementById('select-all-instances').onchange = (e) => {
      if (e.target.checked) {
        instances.forEach(inst => this.migrationSelectedInstances.add(inst.id));
      } else {
        this.migrationSelectedInstances.clear();
      }
      this.renderMigrationInstanceList();
    };

    container.querySelectorAll('input[data-instance]').forEach(checkbox => {
      checkbox.onchange = (e) => {
        e.stopPropagation();
        const instanceId = e.target.dataset.instance;
        if (e.target.checked) {
          this.migrationSelectedInstances.add(instanceId);
        } else {
          this.migrationSelectedInstances.delete(instanceId);
        }
        this.renderMigrationInstanceList();
      };
    });

    container.querySelectorAll('.migration-instance-item').forEach(item => {
      item.onclick = (e) => {
        if (e.target.type === 'checkbox') return;
        const instanceId = item.dataset.id;
        if (this.migrationSelectedInstances.has(instanceId)) {
          this.migrationSelectedInstances.delete(instanceId);
        } else {
          this.migrationSelectedInstances.add(instanceId);
        }
        this.renderMigrationInstanceList();
      };
    });

    document.getElementById('btn-check-migration').disabled = 
      !this.migrationTargetMachineId || this.migrationSelectedInstances.size === 0;
  }

  async checkMigration() {
    if (!this.migrationSourceMachine || !this.migrationTargetMachineId || this.migrationSelectedInstances.size === 0) {
      return;
    }

    try {
      const res = await fetch(API_BASE + '/api/migration/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceMachineId: this.migrationSourceMachine.id,
          targetMachineId: this.migrationTargetMachineId,
          instanceIds: [...this.migrationSelectedInstances]
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      this.migrationCheckResult = await res.json();
      this.renderCheckResult();
      this.showMigrationStep('check');
    } catch (e) {
      toast('检查失败: ' + e.message, 'error');
    }
  }

  renderCheckResult() {
    const result = this.migrationCheckResult;
    if (!result) return;

    document.getElementById('check-migratable-count').textContent = result.migratableCount;
    document.getElementById('check-blocked-count').textContent = result.blockedCount;
    
    const warningCount = result.instances.filter(r => r.warnings && r.warnings.length > 0 && r.canMigrate).length;
    document.getElementById('check-warning-count').textContent = warningCount;

    const container = document.getElementById('migration-check-results');
    container.innerHTML = result.instances.map(inst => {
      const sourceMachine = this.machines.find(m => m.id === result.sourceMachine.id);
      const state = sourceMachine && sourceMachine.definition
        ? sourceMachine.definition.states.find(s => s.id === inst.currentStateId)
        : null;
      const stateName = state ? state.name : inst.currentStateId;

      return `
        <div class="check-result-item">
          <div class="result-header">
            <span class="result-id">${escapeHtml(inst.instanceId)} · ${escapeHtml(stateName)}</span>
            <span class="result-status ${inst.canMigrate ? 'status-migratable' : 'status-blocked'}">
              ${inst.canMigrate ? '可迁移' : '不可迁移'}
            </span>
          </div>
          ${inst.reason ? `<div class="result-reason">${escapeHtml(inst.reason)}</div>` : ''}
          ${inst.warnings && inst.warnings.length > 0 ? `
            <div class="result-warnings">
              ${inst.warnings.map(w => `<div>⚠️ ${escapeHtml(w)}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }

  async executeMigration() {
    if (!this.migrationCheckResult) return;

    const migratableIds = this.migrationCheckResult.instances
      .filter(r => r.canMigrate)
      .map(r => r.instanceId);

    if (migratableIds.length === 0) {
      toast('没有可迁移的实例', 'error');
      return;
    }

    if (!confirm(`确认将 ${migratableIds.length} 个实例从 v${this.migrationCheckResult.sourceMachine.version} 迁移到 v${this.migrationCheckResult.targetMachine.version}？`)) {
      return;
    }

    this.showMigrationStep('execute');
    document.getElementById('migration-progress-fill').style.width = '10%';
    document.getElementById('migration-progress-text').textContent = `正在迁移 0/${migratableIds.length}...`;

    try {
      const res = await fetch(API_BASE + '/api/migration/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceMachineId: this.migrationCheckResult.sourceMachine.id,
          targetMachineId: this.migrationCheckResult.targetMachine.id,
          instanceIds: migratableIds,
          operator: 'user'
        })
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      const executeResult = await res.json();
      
      document.getElementById('migration-progress-fill').style.width = '100%';
      document.getElementById('migration-progress-text').textContent = 
        `完成: ${executeResult.successCount} 成功, ${executeResult.failedCount} 失败`;

      this.renderExecuteResult(executeResult);
      
      await this.loadMachines();
      if (this.selectedMachine) {
        await this.loadInstances();
      }
    } catch (e) {
      document.getElementById('migration-progress-text').textContent = '迁移失败: ' + e.message;
      toast('迁移失败: ' + e.message, 'error');
    }
  }

  renderExecuteResult(result) {
    const container = document.getElementById('migration-execute-results');
    container.innerHTML = result.results.map(r => {
      const sourceMachine = this.machines.find(m => m.id === result.sourceMachine.id);
      const targetMachine = this.machines.find(m => m.id === result.targetMachine.id);
      
      let fromStateName = r.fromStateId;
      let toStateName = r.toStateId;
      
      if (sourceMachine && sourceMachine.definition) {
        const fromState = sourceMachine.definition.states.find(s => s.id === r.fromStateId);
        if (fromState) fromStateName = fromState.name;
      }
      if (targetMachine && targetMachine.definition) {
        const toState = targetMachine.definition.states.find(s => s.id === r.toStateId);
        if (toState) toStateName = toState.name;
      }

      return `
        <div class="execute-result-item">
          <div class="result-header">
            <span class="result-id">${escapeHtml(r.instanceId)}</span>
            <span class="result-status ${r.success ? 'status-success' : 'status-failed'}">
              ${r.success ? '成功' : '失败'}
            </span>
          </div>
          ${r.success ? `
            <div style="font-size:12px;color:#52c41a;">
              ${escapeHtml(fromStateName)} → ${escapeHtml(toStateName)}
            </div>
          ` : `
            <div class="result-reason">${escapeHtml(r.error)}</div>
          `}
          ${r.warnings && r.warnings.length > 0 ? `
            <div class="result-warnings">
              ${r.warnings.map(w => `<div>⚠️ ${escapeHtml(w)}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
  }
}

class SimulationLab {
  constructor() {
    this.currentSimulation = null;
    this.currentBranchId = null;
    this.branches = [];
    this.compareMode = false;
    this.compareBranchA = null;
    this.compareBranchB = null;
    this.isPlaying = false;
    this.playInterval = null;
    this.bindEvents();
  }

  bindEvents() {
    document.getElementById('btn-open-simulation').addEventListener('click', () => this.openModal());
    document.getElementById('btn-close-simulation').addEventListener('click', () => this.closeModal());
    document.getElementById('btn-create-simulation').addEventListener('click', () => this.showCreateView());
    document.getElementById('btn-back-to-list').addEventListener('click', () => this.showListView());
    document.getElementById('btn-back-to-list-from-detail').addEventListener('click', () => this.showListView());
    document.getElementById('btn-delete-simulation').addEventListener('click', () => this.deleteSimulation());
    document.getElementById('btn-refresh-source').addEventListener('click', () => this.refreshSource());
    document.getElementById('btn-new-from-latest').addEventListener('click', () => this.createBranchFromLatest());
    document.getElementById('btn-submit-create-simulation').addEventListener('click', () => this.createSimulation());
    document.getElementById('btn-play-all').addEventListener('click', () => this.togglePlayback());
    document.getElementById('btn-reset').addEventListener('click', () => this.resetTimeline());
    document.getElementById('btn-sim-send-event').addEventListener('click', () => this.sendEvent());
    document.getElementById('btn-sim-timeout').addEventListener('click', () => this.simulateTimeout());
    document.getElementById('btn-add-branch').addEventListener('click', () => this.openForkModal());
    document.getElementById('btn-close-fork').addEventListener('click', () => this.closeForkModal());
    document.getElementById('btn-cancel-fork').addEventListener('click', () => this.closeForkModal());
    document.getElementById('btn-confirm-fork').addEventListener('click', () => this.confirmFork());
    document.getElementById('enable-compare').addEventListener('change', (e) => this.toggleCompareMode(e.target.checked));
    document.getElementById('btn-run-compare').addEventListener('click', () => this.runComparison());
    document.getElementById('simulation-search').addEventListener('input', (e) => this.filterSimulations(e.target.value));
    
    document.querySelectorAll('input[name="sourceType"]').forEach(radio => {
      radio.addEventListener('change', (e) => this.toggleSourceType(e.target.value));
    });
    
    document.getElementById('simulation-machine-select').addEventListener('change', (e) => this.loadInstancesForMachine(e.target.value));
  }

  async openModal() {
    document.getElementById('simulation-modal').style.display = 'flex';
    await this.showListView();
    await this.loadPublishedMachines();
  }

  closeModal() {
    document.getElementById('simulation-modal').style.display = 'none';
    this.stopPlayback();
  }

  showView(viewId) {
    document.querySelectorAll('.simulation-view').forEach(v => v.style.display = 'none');
    document.getElementById(viewId).style.display = 'flex';
  }

  async showListView() {
    this.showView('simulation-list-view');
    await this.loadSimulations();
  }

  showCreateView() {
    this.showView('simulation-create-view');
    document.getElementById('simulation-name').value = '';
    document.getElementById('simulation-machine-select').value = '';
    document.getElementById('simulation-instance-select').value = '';
    document.querySelector('input[name="sourceType"][value="machine"]').checked = true;
    this.toggleSourceType('machine');
  }

  async showDetailView(simulationId) {
    this.showView('simulation-detail-view');
    await this.loadSimulationDetail(simulationId);
  }

  toggleSourceType(type) {
    if (type === 'machine') {
      document.getElementById('machine-select-section').style.display = 'block';
      document.getElementById('instance-select-section').style.display = 'none';
    } else {
      document.getElementById('machine-select-section').style.display = 'block';
      document.getElementById('instance-select-section').style.display = 'block';
    }
  }

  async loadPublishedMachines() {
    try {
      const res = await fetch('/api/machines?status=published');
      const machines = await res.json();
      const select = document.getElementById('simulation-machine-select');
      select.innerHTML = '<option value="">-- 请选择状态机 --</option>';
      machines.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (v${m.version})`;
        select.appendChild(opt);
      });
      
      const forkSelect = document.getElementById('fork-machine-select');
      forkSelect.innerHTML = '<option value="">-- 使用当前版本 --</option>';
      machines.forEach(m => {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.name} (v${m.version})`;
        forkSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('加载状态机失败:', e);
    }
  }

  async loadInstancesForMachine(machineId) {
    const instanceSelect = document.getElementById('simulation-instance-select');
    instanceSelect.innerHTML = '<option value="">-- 加载中... --</option>';
    
    if (!machineId) {
      instanceSelect.innerHTML = '<option value="">-- 请先选择状态机 --</option>';
      return;
    }
    
    try {
      const res = await fetch(`/api/machines/${machineId}/instances`);
      const instances = await res.json();
      instanceSelect.innerHTML = '<option value="">-- 请选择运行实例 --</option>';
      instances.forEach(inst => {
        const opt = document.createElement('option');
        opt.value = inst.id;
        const currentState = inst.current_state_id || 'unknown';
        const status = inst.status || 'running';
        opt.textContent = `实例 ${inst.id.slice(0, 8)}... - ${currentState} (${status})`;
        instanceSelect.appendChild(opt);
      });
    } catch (e) {
      console.error('加载实例失败:', e);
      instanceSelect.innerHTML = '<option value="">-- 加载失败 --</option>';
    }
  }

  async loadSimulations() {
    const container = document.getElementById('simulation-list');
    container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;">加载中...</div>';
    
    try {
      const res = await fetch('/api/simulations');
      const simulations = await res.json();
      this.allSimulations = simulations;
      this.renderSimulationList(simulations);
    } catch (e) {
      container.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#ff4d4f;">加载失败</div>';
      console.error(e);
    }
  }

  filterSimulations(keyword) {
    if (!this.allSimulations) return;
    const filtered = this.allSimulations.filter(s => 
      s.name.toLowerCase().includes(keyword.toLowerCase()) ||
      (s.source_type === 'machine' ? '状态机' : '实例').includes(keyword)
    );
    this.renderSimulationList(filtered);
  }

  renderSimulationList(simulations) {
    const container = document.getElementById('simulation-list');
    if (simulations.length === 0) {
      container.innerHTML = `
        <div class="simulation-empty">
          <div class="simulation-empty-icon">🔬</div>
          <div style="font-size:16px;margin-bottom:8px;">还没有推演记录</div>
          <div style="font-size:13px;">点击上方 "新建推演" 按钮开始第一次推演</div>
        </div>
      `;
      return;
    }
    
    container.innerHTML = simulations.map(s => `
      <div class="simulation-card" data-id="${s.id}">
        <div class="simulation-card-header">
          <div class="simulation-card-name">${escapeHtml(s.name)}</div>
          <span class="simulation-card-type">${s.source_type === 'machine' ? '📋 状态机' : '🚀 实例'}</span>
        </div>
        <div class="simulation-card-meta">
          ${s.source_type === 'machine' 
            ? `来源状态机: ${escapeHtml(s.source_machine_id || '-')}`
            : `来源实例: ${escapeHtml(s.source_instance_id || '-')}`
          }
        </div>
        <div class="simulation-card-stats">
          <div class="simulation-card-stat">📂 <strong>${s.branch_count || 0}</strong> 分支</div>
          <div class="simulation-card-stat">⚡ <strong>${s.step_count || 0}</strong> 步骤</div>
          <div class="simulation-card-stat">🕒 ${this.formatTime(s.created_at)}</div>
        </div>
      </div>
    `).join('');
    
    container.querySelectorAll('.simulation-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.getAttribute('data-id');
        this.showDetailView(id);
      });
    });
  }

  async createSimulation() {
    const name = document.getElementById('simulation-name').value.trim();
    const sourceType = document.querySelector('input[name="sourceType"]:checked').value;
    const sourceMachineId = document.getElementById('simulation-machine-select').value;
    const sourceInstanceId = document.getElementById('simulation-instance-select').value;
    
    if (!name) {
      alert('请输入推演名称');
      return;
    }
    if (!sourceMachineId) {
      alert('请选择状态机');
      return;
    }
    if (sourceType === 'instance' && !sourceInstanceId) {
      alert('请选择运行实例');
      return;
    }
    
    try {
      const res = await fetch('/api/simulations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, sourceType, sourceMachineId, sourceInstanceId })
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      await this.showDetailView(result.simulation.id);
    } catch (e) {
      alert('创建推演失败: ' + e.message);
      console.error(e);
    }
  }

  async loadSimulationDetail(simulationId) {
    try {
      const res = await fetch(`/api/simulations/${simulationId}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      
      this.currentSimulation = data.simulation;
      this.branches = data.branches || [];
      
      document.getElementById('simulation-detail-title').textContent = this.currentSimulation.name;
      document.getElementById('simulation-detail-meta').textContent = 
        `${this.currentSimulation.source_type === 'machine' ? '📋 状态机来源' : '🚀 实例来源'} · 创建于 ${this.formatTime(this.currentSimulation.created_at)}`;
      
      if (this.currentSimulation.source_type === 'instance') {
        document.getElementById('btn-refresh-source').style.display = 'inline-block';
        document.getElementById('btn-new-from-latest').style.display = 'inline-block';
      } else {
        document.getElementById('btn-refresh-source').style.display = 'none';
        document.getElementById('btn-new-from-latest').style.display = 'none';
      }
      
      this.renderBranches();
      
      if (this.branches.length > 0) {
        await this.selectBranch(this.branches[0].id);
      }
      
      this.updateCompareSelectors();
    } catch (e) {
      alert('加载推演详情失败: ' + e.message);
      console.error(e);
    }
  }

  renderBranches() {
    const container = document.getElementById('simulation-branches-list');
    container.innerHTML = this.branches.map(b => {
      const parentBranch = this.branches.find(p => p.id === b.parent_branch_id);
      const badgeClass = b.parent_branch_id ? (b.is_refresh ? 'badge-refresh' : 'badge-fork') : 'badge-main';
      const badgeText = b.parent_branch_id ? (b.is_refresh ? '最新快照' : '分叉') : '主分支';
      const parentInfo = parentBranch 
        ? `<div class="branch-item-parent">← ${escapeHtml(parentBranch.name)}${b.parent_step_id ? ` #${b.parent_step_index || ''}` : ''}</div>`
        : '';
      
      return `
        <div class="branch-item ${b.id === this.currentBranchId ? 'active' : ''}" data-id="${b.id}">
          <div class="branch-item-name">
            ${escapeHtml(b.name)}
            <span class="branch-item-badge ${badgeClass}">${badgeText}</span>
          </div>
          <div class="branch-item-meta">
            ${b.step_count || 0} 步 · ${b.is_final ? '🏁 已结束' : '▶️ 运行中'}
          </div>
          ${parentInfo}
        </div>
      `;
    }).join('');
    
    container.querySelectorAll('.branch-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-id');
        this.selectBranch(id);
      });
    });
  }

  async selectBranch(branchId) {
    this.currentBranchId = branchId;
    this.renderBranches();
    this.renderCurrentBranchIndicator();
    await this.loadBranchDetail(branchId);
  }

  renderCurrentBranchIndicator() {
    const branch = this.branches.find(b => b.id === this.currentBranchId);
    if (branch) {
      document.getElementById('current-branch-indicator').textContent = 
        `当前分支: ${branch.name}`;
    }
  }

  async loadBranchDetail(branchId) {
    try {
      const res = await fetch(`/api/simulations/branches/${branchId}`);
      const branch = await res.json();
      if (branch.error) throw new Error(branch.error);
      
      const idx = this.branches.findIndex(b => b.id === branchId);
      if (idx !== -1) {
        this.branches[idx] = branch;
      }
      
      this.renderTimeline(branch.steps || []);
      this.renderCurrentState(branch);
      this.renderAvailableEvents(branch);
      this.renderTimeoutInfo(branch);
      this.drawSimulationCanvas(branch, 'a');
      
      if (this.compareMode && this.compareBranchB) {
        await this.loadBranchForCompare(this.compareBranchB, 'b');
      }
    } catch (e) {
      console.error('加载分支详情失败:', e);
    }
  }

  renderTimeline(steps) {
    const container = document.getElementById('simulation-timeline');
    
    if (steps.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:20px;color:#8c8c8c;">暂无步骤记录</div>';
      return;
    }
    
    container.innerHTML = steps.map((step, idx) => this.renderTimelineStep(step, idx)).join('');
    
    container.querySelectorAll('.timeline-step').forEach(stepEl => {
      stepEl.addEventListener('click', () => {
        const stepId = stepEl.getAttribute('data-id');
        this.highlightTimelineStep(stepId);
      });
    });
    
    const lastStep = container.querySelector('.timeline-step:last-child');
    if (lastStep) {
      lastStep.classList.add('active');
    }
  }

  renderTimelineStep(step, idx) {
    const type = step.step_type || 'transition';
    let typeLabel = type;
    let icon = '⚡';
    
    switch (type) {
      case 'initial': typeLabel = '初始状态'; icon = '🌱'; break;
      case 'fork': typeLabel = '分叉创建'; icon = '🌿'; break;
      case 'transition': typeLabel = '事件流转'; icon = '➡️'; break;
      case 'timeout_wait': typeLabel = '超时等待'; icon = '⏳'; break;
      case 'timeout': typeLabel = '超时触发'; icon = '⏰'; break;
      case 'refresh': typeLabel = '同步快照'; icon = '🔄'; break;
    }
    
    const guardResult = step.guard_result ? JSON.parse(step.guard_result) : null;
    const complianceResult = step.compliance_result ? JSON.parse(step.compliance_result) : null;
    const timeoutInfo = step.timeout_info ? JSON.parse(step.timeout_info) : null;
    
    let extraClass = '';
    if (type === 'initial') extraClass = 'initial';
    else if (type === 'fork' || type === 'refresh') extraClass = 'fork';
    else if (type === 'timeout_wait') extraClass = 'timeout_wait';
    else if (type === 'timeout') extraClass = 'timeout';
    
    if (guardResult && !guardResult.passed) extraClass += ' guard-failed';
    if (complianceResult && complianceResult.blocked) extraClass += ' compliance-blocked';
    
    let detail = '';
    if (guardResult) {
      detail += `<div class="timeline-step-detail">`;
      detail += `<span class="${guardResult.passed ? 'guard-pass' : 'guard-fail'}">`;
      detail += `🛡️ 守卫: ${guardResult.passed ? '放行' : '拦截'}`;
      if (guardResult.reason) detail += ` - ${escapeHtml(guardResult.reason)}`;
      detail += `</span>`;
      detail += `</div>`;
    }
    
    if (complianceResult) {
      detail += `<div class="timeline-step-detail">`;
      detail += `<span class="violation">`;
      detail += `⚖️ 合规: ${complianceResult.blocked ? '拦截' : '通过'}`;
      if (complianceResult.violations && complianceResult.violations.length > 0) {
        detail += ` - ${complianceResult.violations.length} 项违规`;
      }
      detail += `</span>`;
      detail += `</div>`;
    }
    
    if (timeoutInfo) {
      detail += `<div class="timeline-step-detail">`;
      detail += `⏱️ 模拟等待 ${timeoutInfo.simulated_seconds || 0} 秒`;
      if (timeoutInfo.triggered) {
        detail += ` → 超时已触发`;
      }
      detail += `</div>`;
    }
    
    const content = type === 'initial' 
      ? `进入 <strong>${escapeHtml(step.to_state_id || '')}</strong>`
      : type === 'fork'
      ? `从 <strong>${escapeHtml(step.from_state_id || '')}</strong> 分叉`
      : step.event_name 
        ? `<strong>${escapeHtml(step.event_name)}</strong>: ${escapeHtml(step.from_state_id || '')} → <strong>${escapeHtml(step.to_state_id || step.from_state_id || '')}</strong>`
        : `${escapeHtml(step.from_state_id || '')} → <strong>${escapeHtml(step.to_state_id || '')}</strong>`;
    
    return `
      <div class="timeline-step ${extraClass}" data-id="${step.id}" data-idx="${idx}">
        <div class="timeline-step-header">
          <span class="timeline-step-type">${icon} ${typeLabel}</span>
          <span class="timeline-step-time">#${idx + 1} ${this.formatTime(step.created_at)}</span>
        </div>
        <div class="timeline-step-content">${content}</div>
        ${step.duration_ms != null ? `<div class="timeline-step-detail">⏱️ 耗时 ${step.duration_ms}ms</div>` : ''}
        ${detail}
      </div>
    `;
  }

  highlightTimelineStep(stepId) {
    document.querySelectorAll('.timeline-step').forEach(el => el.classList.remove('active'));
    const stepEl = document.querySelector(`.timeline-step[data-id="${stepId}"]`);
    if (stepEl) {
      stepEl.classList.add('active');
      stepEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  renderCurrentState(branch) {
    const container = document.getElementById('current-state-info');
    const machine = branch.machine_snapshot ? JSON.parse(branch.machine_snapshot) : null;
    const context = branch.context_data ? JSON.parse(branch.context_data) : {};
    const state = machine ? machine.states.find(s => s.id === branch.current_state_id) : null;
    
    let contextStr = JSON.stringify(context);
    if (contextStr.length > 100) {
      contextStr = contextStr.slice(0, 100) + '...';
    }
    
    container.innerHTML = `
      <div>状态: <span class="state-name">${escapeHtml(state ? state.name : branch.current_state_id)}</span></div>
      <div style="margin-top:4px;">ID: <code style="font-size:10px;">${escapeHtml(branch.current_state_id)}</code></div>
      <div style="margin-top:4px;">上下文:</div>
      <div class="context-preview">${escapeHtml(contextStr)}</div>
      ${branch.is_final ? '<div style="margin-top:6px;color:#52c41a;font-weight:600;">🏁 已到达终态</div>' : ''}
    `;
  }

  renderAvailableEvents(branch) {
    const container = document.getElementById('available-events');
    const machine = branch.machine_snapshot ? JSON.parse(branch.machine_snapshot) : null;
    
    if (!machine || branch.is_final) {
      container.innerHTML = '<div style="font-size:11px;color:#8c8c8c;">已到达终态，无可用事件</div>';
      return;
    }
    
    const currentState = machine.states.find(s => s.id === branch.current_state_id);
    if (!currentState || !currentState.transitions) {
      container.innerHTML = '<div style="font-size:11px;color:#8c8c8c;">当前状态无可用流转</div>';
      return;
    }
    
    const events = [...new Set(currentState.transitions.map(t => t.event))];
    
    container.innerHTML = events.map(event => {
      const transitions = currentState.transitions.filter(t => t.event === event);
      const hasGuard = transitions.some(t => t.guard && t.guard.script);
      return `
        <span class="event-chip ${hasGuard ? 'with-guard' : ''}" data-event="${escapeHtml(event)}">
          ${hasGuard ? '🛡️ ' : ''}${escapeHtml(event)}
        </span>
      `;
    }).join('');
    
    container.querySelectorAll('.event-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const event = chip.getAttribute('data-event');
        document.getElementById('sim-event-name').value = event;
        document.getElementById('sim-event-payload').focus();
      });
    });
  }

  renderTimeoutInfo(branch) {
    const container = document.getElementById('timeout-info');
    const machine = branch.machine_snapshot ? JSON.parse(branch.machine_snapshot) : null;
    
    if (!machine) {
      container.innerHTML = '';
      return;
    }
    
    const currentState = machine.states.find(s => s.id === branch.current_state_id);
    if (!currentState || !currentState.timeout) {
      container.innerHTML = '<span style="color:#8c8c8c;">当前状态无超时配置</span>';
      return;
    }
    
    const timeout = currentState.timeout;
    container.innerHTML = `
      <div>
        <strong>⏰ 超时配置:</strong> ${timeout.seconds} 秒后触发 <code>${escapeHtml(timeout.target || '')}</code>
      </div>
      ${branch.entered_state_at ? `
        <div style="margin-top:2px;">
          进入状态时间: ${this.formatTime(branch.entered_state_at)}
        </div>
      ` : ''}
    `;
  }

  drawSimulationCanvas(branch, canvasId) {
    const canvas = document.getElementById(`simulation-canvas-${canvasId}`);
    if (!canvas) return;
    
    const machine = branch.machine_snapshot ? JSON.parse(branch.machine_snapshot) : null;
    if (!machine) return;
    
    const wrapper = canvas.parentElement;
    const watermark = wrapper.querySelector('.sandbox-watermark');
    if (!watermark) {
      const wm = document.createElement('div');
      wm.className = 'sandbox-watermark';
      wm.textContent = '推演沙盘';
      wrapper.appendChild(wm);
    }
    
    const padding = 60;
    const stateRadius = 50;
    const levelHeight = 180;
    const levelWidth = 250;
    
    const levels = this.calculateStateLevels(machine);
    const maxLevelCount = Math.max(...levels.map(l => l.length), 1);
    
    canvas.width = Math.max(levels.length * levelWidth + padding * 2, wrapper.clientWidth);
    canvas.height = Math.max(maxLevelCount * levelHeight + padding * 2, wrapper.clientHeight - 40);
    
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    const statePositions = {};
    levels.forEach((levelStates, levelIdx) => {
      const levelY = padding + levelIdx * levelHeight + levelHeight / 2;
      const totalWidth = levelStates.length * stateRadius * 3;
      const startX = (canvas.width - totalWidth) / 2 + stateRadius * 1.5;
      
      levelStates.forEach((stateId, stateIdx) => {
        const x = startX + stateIdx * stateRadius * 3;
        statePositions[stateId] = { x, y: levelY };
      });
    });
    
    machine.states.forEach(state => {
      const transitions = state.transitions || [];
      transitions.forEach(trans => {
        const from = statePositions[state.id];
        const to = statePositions[trans.target];
        if (from && to) {
          this.drawTransition(ctx, from, to, trans, stateRadius, branch, state.id);
        }
      });
      
      if (state.timeout && state.timeout.target) {
        const from = statePositions[state.id];
        const to = statePositions[state.timeout.target];
        if (from && to) {
          this.drawTimeoutTransition(ctx, from, to, state.timeout, stateRadius);
        }
      }
    });
    
    machine.states.forEach(state => {
      const pos = statePositions[state.id];
      if (pos) {
        const isCurrent = state.id === branch.current_state_id;
        const isInitial = state.id === machine.initialStateId;
        this.drawState(ctx, pos.x, pos.y, state, stateRadius, isCurrent, isInitial);
      }
    });
    
    const labelEl = document.getElementById(`canvas-${canvasId}-label`);
    if (labelEl) {
      labelEl.textContent = canvasId === 'a' 
        ? `分支 A: ${branch.name} - 当前状态: ${this.getStateName(machine, branch.current_state_id)}`
        : `分支 B: ${branch.name} - 当前状态: ${this.getStateName(machine, branch.current_state_id)}`;
    }
  }

  getStateName(machine, stateId) {
    const state = machine.states.find(s => s.id === stateId);
    return state ? state.name : stateId;
  }

  calculateStateLevels(machine) {
    const visited = new Set();
    const levels = [];
    const stateLevel = {};
    
    const queue = [{ id: machine.initialStateId, level: 0 }];
    
    while (queue.length > 0) {
      const { id, level } = queue.shift();
      if (visited.has(id)) continue;
      visited.add(id);
      
      if (!levels[level]) levels[level] = [];
      levels[level].push(id);
      stateLevel[id] = level;
      
      const state = machine.states.find(s => s.id === id);
      if (!state) continue;
      
      const transitions = state.transitions || [];
      transitions.forEach(trans => {
        if (!visited.has(trans.target)) {
          queue.push({ id: trans.target, level: level + 1 });
        }
      });
      
      if (state.timeout && state.timeout.target && !visited.has(state.timeout.target)) {
        queue.push({ id: state.timeout.target, level: level + 1 });
      }
    }
    
    machine.states.forEach(state => {
      if (!visited.has(state.id)) {
        let maxLevel = levels.length - 1;
        if (!levels[maxLevel + 1]) levels[maxLevel + 1] = [];
        levels[maxLevel + 1].push(state.id);
      }
    });
    
    return levels.filter(l => l && l.length > 0);
  }

  drawState(ctx, x, y, state, radius, isCurrent, isInitial) {
    ctx.save();
    
    if (isCurrent) {
      ctx.shadowColor = '#722ed1';
      ctx.shadowBlur = 20;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isCurrent ? '#722ed1' : (isInitial ? '#f6ffed' : '#ffffff');
    ctx.fill();
    ctx.strokeStyle = isCurrent ? '#531dab' : (isInitial ? '#52c41a' : '#d9d9d9');
    ctx.lineWidth = isCurrent ? 3 : (isInitial ? 2 : 1.5);
    ctx.stroke();
    
    if (state.type === 'final') {
      ctx.beginPath();
      ctx.arc(x, y, radius - 8, 0, Math.PI * 2);
      ctx.strokeStyle = isCurrent ? '#531dab' : (isInitial ? '#52c41a' : '#8c8c8c');
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    
    ctx.restore();
    
    ctx.fillStyle = isCurrent ? '#ffffff' : '#262626';
    ctx.font = 'bold 13px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(state.name, x, y - 5);
    
    ctx.fillStyle = isCurrent ? 'rgba(255,255,255,0.7)' : '#8c8c8c';
    ctx.font = '10px monospace';
    ctx.fillText(state.id.slice(0, 8), x, y + 12);
    
    if (state.timeout) {
      ctx.fillStyle = isCurrent ? '#fff7e6' : '#fffbe6';
      ctx.font = '10px sans-serif';
      ctx.fillText(`⏰ ${state.timeout.seconds}s`, x, y + radius + 15);
    }
  }

  drawTransition(ctx, from, to, trans, radius, branch, fromStateId) {
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    const startX = from.x + (dx / distance) * radius;
    const startY = from.y + (dy / distance) * radius;
    const endX = to.x - (dx / distance) * (radius + 10);
    const endY = to.y - (dy / distance) * (radius + 10);
    
    const steps = branch.steps || [];
    const isTaken = steps.some(s => 
      s.step_type === 'transition' && 
      s.from_state_id === fromStateId && 
      s.to_state_id === trans.target &&
      (!trans.event || s.event_name === trans.event)
    );
    
    const guardResult = trans.guard && trans.guard.script;
    
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(endX, endY);
    ctx.strokeStyle = isTaken ? '#722ed1' : (guardResult ? '#fa8c16' : '#bfbfbf');
    ctx.lineWidth = isTaken ? 2.5 : 1.5;
    if (isTaken) ctx.setLineDash([]);
    else if (guardResult) ctx.setLineDash([5, 3]);
    else ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const angle = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - 10 * Math.cos(angle - Math.PI / 6), endY - 10 * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(endX - 10 * Math.cos(angle + Math.PI / 6), endY - 10 * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = isTaken ? '#722ed1' : (guardResult ? '#fa8c16' : '#bfbfbf');
    ctx.fill();
    
    ctx.save();
    ctx.translate(midX, midY);
    if (dx < 0) ctx.rotate(angle + Math.PI);
    else ctx.rotate(angle);
    
    ctx.fillStyle = isTaken ? '#f9f0ff' : '#ffffff';
    ctx.strokeStyle = isTaken ? '#722ed1' : '#d9d9d9';
    ctx.lineWidth = 1;
    const label = trans.event || '';
    const labelWidth = ctx.measureText(label).width + 16;
    
    ctx.fillRect(-labelWidth / 2, -12, labelWidth, 24);
    ctx.strokeRect(-labelWidth / 2, -12, labelWidth, 24);
    
    ctx.fillStyle = isTaken ? '#722ed1' : '#595959';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${guardResult ? '🛡️ ' : ''}${label}`, 0, 0);
    
    ctx.restore();
  }

  drawTimeoutTransition(ctx, from, to, timeout, radius) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    
    const startX = from.x + (dx / distance) * radius;
    const startY = from.y + (dy / distance) * radius;
    const endX = to.x - (dx / distance) * (radius + 10);
    const endY = to.y - (dy / distance) * (radius + 10);
    
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.quadraticCurveTo(
      (from.x + to.x) / 2 + 30,
      (from.y + to.y) / 2 - 30,
      endX, endY
    );
    ctx.strokeStyle = '#faad14';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    
    const angle = Math.atan2(endY - ((from.y + to.y) / 2 - 30), endX - ((from.x + to.x) / 2 + 30));
    ctx.beginPath();
    ctx.moveTo(endX, endY);
    ctx.lineTo(endX - 10 * Math.cos(angle - Math.PI / 6), endY - 10 * Math.sin(angle - Math.PI / 6));
    ctx.lineTo(endX - 10 * Math.cos(angle + Math.PI / 6), endY - 10 * Math.sin(angle + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = '#faad14';
    ctx.fill();
    
    const midX = (from.x + to.x) / 2 + 30;
    const midY = (from.y + to.y) / 2 - 30;
    
    ctx.fillStyle = '#fffbe6';
    ctx.strokeStyle = '#faad14';
    ctx.lineWidth = 1;
    const label = `⏰ ${timeout.seconds}s`;
    ctx.font = '10px sans-serif';
    const labelWidth = ctx.measureText(label).width + 12;
    ctx.fillRect(midX - labelWidth / 2, midY - 10, labelWidth, 20);
    ctx.strokeRect(midX - labelWidth / 2, midY - 10, labelWidth, 20);
    
    ctx.fillStyle = '#fa8c16';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, midX, midY);
  }

  async sendEvent() {
    const eventName = document.getElementById('sim-event-name').value.trim();
    const payloadStr = document.getElementById('sim-event-payload').value.trim();
    
    if (!eventName) {
      alert('请输入事件名');
      return;
    }
    
    let payload = {};
    if (payloadStr) {
      try {
        payload = JSON.parse(payloadStr);
      } catch (e) {
        alert('Payload 必须是有效的 JSON');
        return;
      }
    }
    
    if (!this.currentBranchId) return;
    
    try {
      const res = await fetch(`/api/simulations/branches/${this.currentBranchId}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: eventName, payload })
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      document.getElementById('sim-event-payload').value = '';
      await this.loadBranchDetail(this.currentBranchId);
      this.renderBranches();
      
      if (result.step) {
        this.highlightTimelineStep(result.step.id);
      }
    } catch (e) {
      alert('发送事件失败: ' + e.message);
      console.error(e);
    }
  }

  async simulateTimeout() {
    const seconds = parseInt(document.getElementById('sim-timeout-seconds').value, 10);
    if (!seconds || seconds <= 0) {
      alert('请输入有效的秒数');
      return;
    }
    
    if (!this.currentBranchId) return;
    
    try {
      const res = await fetch(`/api/simulations/branches/${this.currentBranchId}/timeout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulateSeconds: seconds })
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      await this.loadBranchDetail(this.currentBranchId);
      this.renderBranches();
      
      if (result.step) {
        this.highlightTimelineStep(result.step.id);
      }
    } catch (e) {
      alert('模拟超时失败: ' + e.message);
      console.error(e);
    }
  }

  togglePlayback() {
    if (this.isPlaying) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
  }

  startPlayback() {
    const branch = this.branches.find(b => b.id === this.currentBranchId);
    if (!branch || !branch.steps || branch.steps.length <= 1) {
      alert('没有足够的步骤用于回放');
      return;
    }
    
    this.isPlaying = true;
    this.currentPlaybackIndex = 0;
    const steps = branch.steps;
    
    const indicator = document.createElement('div');
    indicator.className = 'playback-indicator';
    indicator.id = 'playback-indicator';
    indicator.innerHTML = `
      <span>▶️ 回放中...</span>
      <span id="playback-progress">1/${steps.length}</span>
      <button onclick="window.simulationLab.stopPlayback()">停止</button>
    `;
    document.body.appendChild(indicator);
    
    this.playInterval = setInterval(() => {
      this.currentPlaybackIndex++;
      if (this.currentPlaybackIndex >= steps.length) {
        this.stopPlayback();
        return;
      }
      
      const step = steps[this.currentPlaybackIndex];
      this.highlightTimelineStep(step.id);
      document.getElementById('playback-progress').textContent = 
        `${this.currentPlaybackIndex + 1}/${steps.length}`;
      
      const machine = branch.machine_snapshot ? JSON.parse(branch.machine_snapshot) : null;
      if (machine) {
        const tempBranch = {
          ...branch,
          current_state_id: step.to_state_id || step.from_state_id
        };
        this.drawSimulationCanvas(tempBranch, 'a');
      }
    }, 800);
  }

  stopPlayback() {
    this.isPlaying = false;
    if (this.playInterval) {
      clearInterval(this.playInterval);
      this.playInterval = null;
    }
    
    const indicator = document.getElementById('playback-indicator');
    if (indicator) indicator.remove();
    
    if (this.currentBranchId) {
      this.loadBranchDetail(this.currentBranchId);
    }
  }

  resetTimeline() {
    if (!this.currentBranchId) return;
    
    const branch = this.branches.find(b => b.id === this.currentBranchId);
    if (!branch || !branch.steps || branch.steps.length === 0) return;
    
    const firstStep = branch.steps[0];
    this.highlightTimelineStep(firstStep.id);
  }

  openForkModal() {
    const branch = this.branches.find(b => b.id === this.currentBranchId);
    if (!branch) return;
    
    document.getElementById('fork-branch-name').value = `${branch.name} - 分叉`;
    
    const stepSelect = document.getElementById('fork-step-select');
    const steps = branch.steps || [];
    stepSelect.innerHTML = steps.map((s, idx) => `
      <option value="${s.id}" data-idx="${idx}">
        #${idx + 1} - ${s.step_type || 'transition'} - ${s.to_state_id || s.from_state_id}
      </option>
    `).join('');
    
    if (steps.length > 0) {
      stepSelect.value = steps[steps.length - 1].id;
    }
    
    document.getElementById('fork-modal').style.display = 'flex';
  }

  closeForkModal() {
    document.getElementById('fork-modal').style.display = 'none';
  }

  async confirmFork() {
    const name = document.getElementById('fork-branch-name').value.trim();
    const stepSelect = document.getElementById('fork-step-select');
    const stepId = stepSelect.value;
    const stepIdx = parseInt(stepSelect.options[stepSelect.selectedIndex].getAttribute('data-idx'), 10);
    const machineId = document.getElementById('fork-machine-select').value;
    
    if (!name) {
      alert('请输入分支名称');
      return;
    }
    if (!stepId) {
      alert('请选择分叉点');
      return;
    }
    
    if (!this.currentBranchId) return;
    
    try {
      const res = await fetch(`/api/simulations/branches/${this.currentBranchId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stepIndex: stepIdx, targetMachineId: machineId || undefined })
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      this.closeForkModal();
      await this.loadSimulationDetail(this.currentSimulation.id);
      await this.selectBranch(result.branch.id);
    } catch (e) {
      alert('创建分叉失败: ' + e.message);
      console.error(e);
    }
  }

  async refreshSource() {
    if (!this.currentSimulation || this.currentSimulation.source_type !== 'instance') return;
    
    if (!confirm('将从源实例拉取最新状态快照，确认同步？')) return;
    
    try {
      const res = await fetch(`/api/simulations/branches/${this.currentBranchId}/refresh`, {
        method: 'POST'
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      alert('同步成功！已基于最新状态创建新分支');
      await this.loadSimulationDetail(this.currentSimulation.id);
      if (result.branch) {
        await this.selectBranch(result.branch.id);
      }
    } catch (e) {
      alert('同步失败: ' + e.message);
      console.error(e);
    }
  }

  async createBranchFromLatest() {
    if (!this.currentSimulation || this.currentSimulation.source_type !== 'instance') return;
    
    const name = prompt('请输入新分支名称:', '最新状态分支');
    if (!name) return;
    
    try {
      const res = await fetch(`/api/simulations/branches/${this.currentBranchId}/new-from-latest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      alert('创建成功！');
      await this.loadSimulationDetail(this.currentSimulation.id);
      await this.selectBranch(result.branch.id);
    } catch (e) {
      alert('创建失败: ' + e.message);
      console.error(e);
    }
  }

  async deleteSimulation() {
    if (!this.currentSimulation) return;
    if (!confirm(`确定要删除推演 "${this.currentSimulation.name}"？此操作不可恢复。`)) return;
    
    try {
      const res = await fetch(`/api/simulations/${this.currentSimulation.id}`, {
        method: 'DELETE'
      });
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      alert('删除成功');
      this.currentSimulation = null;
      this.currentBranchId = null;
      this.branches = [];
      await this.showListView();
    } catch (e) {
      alert('删除失败: ' + e.message);
      console.error(e);
    }
  }

  toggleCompareMode(enabled) {
    this.compareMode = enabled;
    
    const wrapperB = document.getElementById('simulation-canvas-wrapper-b');
    const timeline = document.getElementById('simulation-timeline');
    const compareTimeline = document.getElementById('compare-timeline');
    const compareSection = document.getElementById('compare-section');
    
    if (enabled) {
      wrapperB.style.display = 'block';
      timeline.style.display = 'none';
      compareTimeline.style.display = 'flex';
      compareSection.style.display = 'block';
      
      this.compareBranchA = this.currentBranchId;
      this.updateCompareSelectors();
      
      if (this.branches.length >= 2) {
        this.compareBranchB = this.branches.find(b => b.id !== this.compareBranchA)?.id;
        if (this.compareBranchB) {
          document.getElementById('compare-branch-b').value = this.compareBranchB;
          this.loadBranchForCompare(this.compareBranchB, 'b');
          this.renderCompareTimelines();
        }
      }
    } else {
      wrapperB.style.display = 'none';
      timeline.style.display = 'block';
      compareTimeline.style.display = 'none';
      compareSection.style.display = 'none';
      this.compareBranchB = null;
    }
  }

  updateCompareSelectors() {
    const selectA = document.getElementById('compare-branch-a');
    const selectB = document.getElementById('compare-branch-b');
    
    const options = this.branches.map(b => 
      `<option value="${b.id}">${escapeHtml(b.name)}</option>`
    ).join('');
    
    selectA.innerHTML = options;
    selectB.innerHTML = options;
    
    if (this.compareBranchA) selectA.value = this.compareBranchA;
    if (this.compareBranchB) selectB.value = this.compareBranchB;
  }

  async loadBranchForCompare(branchId, canvasId) {
    try {
      const res = await fetch(`/api/simulations/branches/${branchId}`);
      const branch = await res.json();
      if (branch.error) throw new Error(branch.error);
      
      this.drawSimulationCanvas(branch, canvasId);
      return branch;
    } catch (e) {
      console.error('加载对比分支失败:', e);
      return null;
    }
  }

  renderCompareTimelines() {
    const branchA = this.branches.find(b => b.id === this.compareBranchA);
    const branchB = this.branches.find(b => b.id === this.compareBranchB);
    
    if (!branchA || !branchB) return;
    
    this.loadBranchForCompare(this.compareBranchA, 'a');
    this.loadBranchForCompare(this.compareBranchB, 'b');
    
    document.getElementById('timeline-a').innerHTML = 
      (branchA.steps || []).map((s, i) => this.renderTimelineStep(s, i)).join('');
    
    document.getElementById('timeline-b').innerHTML = 
      (branchB.steps || []).map((s, i) => this.renderTimelineStep(s, i)).join('');
  }

  async runComparison() {
    const branchAId = document.getElementById('compare-branch-a').value;
    const branchBId = document.getElementById('compare-branch-b').value;
    
    if (!branchAId || !branchBId) {
      alert('请选择两个要对比的分支');
      return;
    }
    
    if (branchAId === branchBId) {
      alert('请选择不同的分支进行对比');
      return;
    }
    
    this.compareBranchA = branchAId;
    this.compareBranchB = branchBId;
    this.renderCompareTimelines();
    
    try {
      const res = await fetch(`/api/simulations/branches/compare/${branchAId}/${branchBId}`);
      const result = await res.json();
      if (result.error) throw new Error(result.error);
      
      this.renderComparisonResults(result);
    } catch (e) {
      alert('对比失败: ' + e.message);
      console.error(e);
    }
  }

  renderComparisonResults(result) {
    const container = document.getElementById('compare-results');
    
    const totalStepsA = result.totalStepsA || 0;
    const totalStepsB = result.totalStepsB || 0;
    const stepDiff = totalStepsB - totalStepsA;
    
    const totalTimeA = result.totalDurationA || 0;
    const totalTimeB = result.totalDurationB || 0;
    const timeDiff = totalTimeB - totalTimeA;
    
    const violationsA = result.violationsA || 0;
    const violationsB = result.violationsB || 0;
    const violationDiff = violationsB - violationsA;
    
    const divergencePoint = result.divergencePoint != null ? `第 ${result.divergencePoint + 1} 步` : '无';
    
    container.innerHTML = `
      <div class="compare-summary">
        <div class="compare-summary-card">
          <div class="compare-summary-label">步骤数差异</div>
          <div class="compare-summary-value ${stepDiff !== 0 ? (stepDiff > 0 ? 'diff-positive' : 'diff-negative') : ''}">
            ${totalStepsA} → ${totalStepsB} (${stepDiff >= 0 ? '+' : ''}${stepDiff})
          </div>
        </div>
        <div class="compare-summary-card">
          <div class="compare-summary-label">耗时差异</div>
          <div class="compare-summary-value ${timeDiff !== 0 ? (timeDiff > 0 ? 'diff-negative' : 'diff-positive') : ''}">
            ${totalTimeA}ms → ${totalTimeB}ms (${timeDiff >= 0 ? '+' : ''}${timeDiff}ms)
          </div>
        </div>
        <div class="compare-summary-card">
          <div class="compare-summary-label">违规数差异</div>
          <div class="compare-summary-value ${violationDiff !== 0 ? 'diff-negative' : ''}">
            ${violationsA} → ${violationsB} (${violationDiff >= 0 ? '+' : ''}${violationDiff})
          </div>
        </div>
        <div class="compare-summary-card">
          <div class="compare-summary-label">分叉点</div>
          <div class="compare-summary-value">${escapeHtml(divergencePoint)}</div>
        </div>
      </div>
      
      <div class="compare-diff-list">
        ${result.differences.map(diff => this.renderDiffItem(diff)).join('')}
      </div>
    `;
  }

  renderDiffItem(diff) {
    const isSame = diff.type === 'same' || (!diff.difference && diff.a && diff.b && 
      diff.a.to_state_id === diff.b.to_state_id && 
      diff.a.event_name === diff.b.event_name);
    
    const diffClass = isSame ? 'same' : 'different';
    
    let typeLabel = diff.stepType || diff.type;
    if (diff.a?.step_type === 'initial') typeLabel = '初始状态';
    else if (diff.a?.step_type === 'transition') typeLabel = `事件: ${diff.a.event_name || '-'}`;
    else if (diff.a?.step_type === 'timeout') typeLabel = '超时触发';
    
    let typeClass = '';
    if (diff.difference === 'state') typeClass = '状态变化';
    else if (diff.difference === 'event') typeClass = '事件';
    else if (diff.difference === 'guard') typeClass = '守卫';
    else if (diff.difference === 'compliance') typeClass = '合规';
    else if (diff.difference === 'timeout') typeClass = '超时';
    else if (diff.difference === 'duration') typeClass = '耗时';
    
    return `
      <div class="compare-diff-item ${diffClass}">
        <div class="compare-diff-header">
          <span>#${diff.index + 1} - ${escapeHtml(typeLabel)}</span>
          ${typeClass ? `<span class="compare-diff-type">${escapeHtml(typeClass)}</span>` : ''}
        </div>
        <div class="compare-diff-content">
          <div class="compare-diff-side a">
            <div class="diff-label">分支 A</div>
            <div class="diff-value">
              ${diff.a ? this.renderDiffSideValue(diff.a) : '<em>无此步骤</em>'}
            </div>
          </div>
          <div class="compare-diff-side b">
            <div class="diff-label">分支 B</div>
            <div class="diff-value">
              ${diff.b ? this.renderDiffSideValue(diff.b) : '<em>无此步骤</em>'}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  renderDiffSideValue(step) {
    let html = '';
    
    if (step.to_state_id) {
      html += `<div><strong>状态:</strong> ${escapeHtml(step.to_state_id)}</div>`;
    }
    
    if (step.duration_ms != null) {
      html += `<div><strong>耗时:</strong> ${step.duration_ms}ms</div>`;
    }
    
    if (step.guard_result) {
      const guard = JSON.parse(step.guard_result);
      html += `<div>
        <strong>守卫:</strong> 
        <span class="diff-badge ${guard.passed ? 'pass' : 'fail'}">
          ${guard.passed ? '放行' : '拦截'}
        </span>
        ${guard.reason ? `<div style="font-size:10px;color:#8c8c8c;">${escapeHtml(guard.reason)}</div>` : ''}
      </div>`;
    }
    
    if (step.compliance_result) {
      const comp = JSON.parse(step.compliance_result);
      if (comp.blocked || (comp.violations && comp.violations.length > 0)) {
        html += `<div>
          <strong>合规:</strong>
          <span class="diff-badge violation">${comp.violations?.length || 0} 项违规</span>
          ${comp.violations?.map(v => `<div class="violation-detail">${escapeHtml(v.message)}</div>`).join('')}
        </div>`;
      }
    }
    
    return html || '-';
  }

  updateInstanceFrozenStatus(instanceId, isFrozen, operatorName) {
    const inst = this.instances.find(i => i.id === instanceId);
    if (inst) {
      inst.isFrozen = isFrozen;
      if (isFrozen && operatorName) {
        inst.freezeInfo = inst.freezeInfo || {};
        inst.freezeInfo.isFrozen = true;
        inst.freezeInfo.frozenBy = operatorName;
        inst.freezeInfo.frozenAt = new Date().toISOString();
      } else if (!isFrozen) {
        inst.freezeInfo = null;
        inst.activeTakeover = null;
      }
      this.countInstanceState();
      this.renderInstanceList();
      if (this.selectedInstance === instanceId) {
        this.selectInstance(instanceId);
      }
    }
  }

  bindTakeoverEvents() {
    const modal = document.getElementById('takeover-modal');
    const openBtn = document.getElementById('btn-open-takeover');
    const closeBtn = document.getElementById('takeover-close-btn');

    openBtn.addEventListener('click', () => {
      if (!this.takeoverOperatorName) {
        const name = prompt('请输入您的操作人姓名:', '');
        if (!name) return;
        this.takeoverOperatorName = name.trim();
        localStorage.setItem('takeoverOperatorName', this.takeoverOperatorName);
      }
      this.openTakeoverWorkbench();
    });

    closeBtn.addEventListener('click', () => {
      this.closeTakeoverWorkbench();
    });

    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        this.closeTakeoverWorkbench();
      }
    });

    document.getElementById('takeover-filter-status').addEventListener('change', () => {
      this.renderTakeoverDashboard();
    });

    document.getElementById('takeover-filter-machine').addEventListener('change', () => {
      this.renderTakeoverDashboard();
    });

    document.getElementById('takeover-btn-back').addEventListener('click', () => {
      this.showTakeoverDashboard();
    });

    document.querySelectorAll('.takeover-action-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.takeover-action-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.takeoverCurrentTab = tab.dataset.tab;
        this.renderTakeoverActionPanel();
      });
    });

    document.getElementById('takeover-btn-preview').addEventListener('click', () => {
      this.previewTakeoverAction();
    });

    document.getElementById('takeover-btn-execute').addEventListener('click', () => {
      this.executeTakeoverAction();
    });

    document.getElementById('takeover-btn-resume').addEventListener('click', () => {
      this.resumeInstance();
    });

    document.getElementById('takeover-btn-unfreeze').addEventListener('click', () => {
      this.unfreezeInstance();
    });
  }

  openTakeoverWorkbench() {
    document.getElementById('takeover-modal').style.display = 'flex';
    this.showTakeoverDashboard();
    this.startTakeoverRefreshTimer();
  }

  closeTakeoverWorkbench() {
    document.getElementById('takeover-modal').style.display = 'none';
    this.stopTakeoverRefreshTimer();
    this.currentTakeoverSession = null;
    this.takeoverSessionDetail = null;
  }

  openTakeoverForInstance(instanceId) {
    if (!this.takeoverOperatorName) {
      const name = prompt('请输入您的操作人姓名:', '');
      if (!name) return;
      this.takeoverOperatorName = name.trim();
      localStorage.setItem('takeoverOperatorName', this.takeoverOperatorName);
    }

    const inst = this.instances.find(i => i.id === instanceId);
    if (inst && inst.activeTakeover && inst.activeTakeover.operatorId !== this.takeoverOperatorId) {
      toast(`⚠️ 该实例已被 ${inst.activeTakeover.operatorName} 接管`, 'warning');
      document.getElementById('takeover-modal').style.display = 'flex';
      this.showTakeoverDashboard();
      this.startTakeoverRefreshTimer();
      return;
    }

    fetch(`/api/takeover/instances/${instanceId}/takeover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName,
        reason: '主动接管实例'
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        document.getElementById('takeover-modal').style.display = 'flex';
        this.startTakeoverRefreshTimer();
        this.currentTakeoverSession = result.session;
        this.loadTakeoverSessionDetail(result.session.id);
      } else {
        toast(result.error || '接管失败', 'error');
      }
    }).catch(e => {
      toast('接管失败: ' + e.message, 'error');
    });
  }

  freezeInstance(instanceId) {
    if (!this.takeoverOperatorName) {
      const name = prompt('请输入您的操作人姓名:', '');
      if (!name) return;
      this.takeoverOperatorName = name.trim();
      localStorage.setItem('takeoverOperatorName', this.takeoverOperatorName);
    }

    const reason = prompt('请输入冻结原因:', '实例需要人工介入');
    if (!reason) return;

    fetch(`/api/takeover/instances/${instanceId}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName,
        reason: reason
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        toast('❄️ 实例已冻结，正在打开接管工作台...', 'success');
        this.openTakeoverForInstance(instanceId);
      } else {
        toast(result.error || '冻结失败', 'error');
      }
    }).catch(e => {
      toast('冻结失败: ' + e.message, 'error');
    });
  }

  startTakeoverRefreshTimer() {
    this.stopTakeoverRefreshTimer();
    this.takeoverRefreshTimer = setInterval(() => {
      if (this.currentTakeoverSession) {
        this.loadTakeoverSessionDetail(this.currentTakeoverSession.id);
      } else {
        this.loadTakeoverDashboard();
      }
    }, 5000);
  }

  stopTakeoverRefreshTimer() {
    if (this.takeoverRefreshTimer) {
      clearInterval(this.takeoverRefreshTimer);
      this.takeoverRefreshTimer = null;
    }
  }

  showTakeoverDashboard() {
    this.currentTakeoverSession = null;
    this.takeoverSessionDetail = null;
    document.getElementById('takeover-dashboard-view').style.display = 'block';
    document.getElementById('takeover-session-view').style.display = 'none';
    this.loadTakeoverDashboard();
  }

  loadTakeoverDashboard() {
    fetch('/api/takeover/dashboard').then(r => r.json()).then(result => {
      if (result.success) {
        this.takeoverSessions = result.sessions || [];
        this.renderTakeoverDashboard();
        this.renderTakeoverMachineFilter();
      }
    });
  }

  renderTakeoverMachineFilter() {
    const filter = document.getElementById('takeover-filter-machine');
    const currentValue = filter.value;
    
    const options = ['<option value="">全部状态机</option>'];
    this.machines.forEach(m => {
      options.push(`<option value="${m.id}">${escapeHtml(m.name)}</option>`);
    });
    filter.innerHTML = options.join('');
    filter.value = currentValue || '';
  }

  renderTakeoverDashboard() {
    const statusFilter = document.getElementById('takeover-filter-status').value;
    const machineFilter = document.getElementById('takeover-filter-machine').value;

    let sessions = [...this.takeoverSessions];
    
    if (statusFilter) {
      sessions = sessions.filter(s => s.status === statusFilter);
    }
    if (machineFilter) {
      sessions = sessions.filter(s => s.instance.machineId === machineFilter);
    }

    const frozenCount = this.takeoverSessions.filter(s => s.status === 'active').length;
    const todayCount = this.takeoverSessions.filter(s => {
      const today = new Date().toDateString();
      return new Date(s.createdAt).toDateString() === today;
    }).length;

    document.getElementById('takeover-stat-frozen').textContent = frozenCount;
    document.getElementById('takeover-stat-today').textContent = todayCount;
    document.getElementById('takeover-stat-total').textContent = this.takeoverSessions.length;

    const container = document.getElementById('takeover-instance-list');
    if (sessions.length === 0) {
      container.innerHTML = '<div style="padding:40px;text-align:center;color:#8c8c8c;">暂无需要接管的实例</div>';
      return;
    }

    container.innerHTML = sessions.map(session => {
      const inst = session.instance;
      const isActive = session.status === 'active';
      const machine = this.machines.find(m => m.id === inst.machineId);
      const machineName = machine ? machine.name : inst.machineId;
      const canJoin = isActive && session.operatorId !== this.takeoverOperatorId;

      return `
        <div class="takeover-status-card">
          <div class="takeover-card-header">
            <span class="status-badge ${isActive ? 'danger' : 'success'}">
              ${isActive ? '❄️ 冻结中' : '✅ 已恢复'}
            </span>
            <span class="takeover-time">${this.formatTime(session.createdAt)}</span>
          </div>
          <div class="takeover-card-title">
            ${machineName} - ${inst.id.slice(0, 12)}
          </div>
          <div class="takeover-card-info">
            <div>当前状态: <span class="highlight">${escapeHtml(inst.currentStateName || inst.currentStateId)}</span></div>
            <div>冻结原因: ${escapeHtml(session.reason || '未指定')}</div>
            <div>接管人: <strong>${escapeHtml(session.operatorName)}</strong></div>
            ${inst.pendingEventCount > 0 ? `<div style="color:#d46b08;">📥 排队事件: ${inst.pendingEventCount}</div>` : ''}
            ${inst.recentViolationCount > 0 ? `<div style="color:#cf1322;">⚠️ 近期违规: ${inst.recentViolationCount}</div>` : ''}
          </div>
          <div class="takeover-card-actions">
            <button class="btn btn-sm btn-primary" onclick="app.enterTakeoverSession('${session.id}')">
              ${isActive ? '查看详情' : '查看历史'}
            </button>
            ${canJoin ? `
              <button class="btn btn-sm" style="background:#d46b08;" onclick="app.joinTakeoverSession('${session.id}')">
                加入接管
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  enterTakeoverSession(sessionId) {
    const session = this.takeoverSessions.find(s => s.id === sessionId);
    if (session && session.status === 'active' && session.operatorId !== this.takeoverOperatorId) {
      if (!confirm(`该实例正由 ${session.operatorName} 接管，您要以观察者身份加入吗？`)) {
        return;
      }
    }
    this.currentTakeoverSession = session;
    this.loadTakeoverSessionDetail(sessionId);
  }

  joinTakeoverSession(sessionId) {
    if (!confirm('确认要加入接管？这会同时通知当前接管人。')) return;

    fetch(`/api/takeover/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        toast('已加入接管会话', 'success');
        this.currentTakeoverSession = result.session;
        this.loadTakeoverSessionDetail(sessionId);
      } else {
        toast(result.error || '加入失败', 'error');
      }
    });
  }

  loadTakeoverSessionDetail(sessionId) {
    fetch(`/api/takeover/sessions/${sessionId}`).then(r => r.json()).then(result => {
      if (result.success) {
        this.takeoverSessionDetail = result.detail;
        this.renderTakeoverSession();
      }
    });
  }

  renderTakeoverSession() {
    const detail = this.takeoverSessionDetail;
    if (!detail) return;

    const session = detail.session;
    const instance = detail.instance;
    const isMySession = session.operatorId === this.takeoverOperatorId;
    const machine = this.machines.find(m => m.id === instance.machineId);
    const machineName = machine ? machine.name : instance.machineId;

    document.getElementById('takeover-dashboard-view').style.display = 'none';
    document.getElementById('takeover-session-view').style.display = 'block';

    document.getElementById('takeover-session-header').innerHTML = `
      <div>
        <span class="status-badge ${session.status === 'active' ? 'danger' : 'success'}">
          ${session.status === 'active' ? '❄️ 接管中' : '✅ 已结束'}
        </span>
        <span style="margin-left:8px;font-weight:600;">${machineName}</span>
        <span style="margin-left:8px;font-family:monospace;color:#8c8c8c;">${instance.id}</span>
      </div>
      <div style="font-size:12px;color:#595959;">
        接管人: ${escapeHtml(session.operatorName)} · 开始于 ${this.formatTime(session.createdAt)}
      </div>
    `;

    this.renderTakeoverInstanceState();
    this.renderTakeoverPendingEvents();
    this.renderTakeoverHistory();
    this.renderTakeoverActionLog();
    this.renderTakeoverActionPanel();

    document.getElementById('takeover-btn-execute').disabled = !isMySession || session.status !== 'active';
    document.getElementById('takeover-btn-resume').disabled = !isMySession || session.status !== 'active';
    document.getElementById('takeover-btn-unfreeze').disabled = !isMySession || session.status !== 'active';
  }

  renderTakeoverInstanceState() {
    const detail = this.takeoverSessionDetail;
    const instance = detail.instance;
    const context = instance.context ? JSON.parse(instance.context) : {};
    const contextStr = JSON.stringify(context, null, 2);

    document.getElementById('takeover-current-state').innerHTML = `
      <div style="font-size:18px;font-weight:600;color:#1890ff;">${escapeHtml(instance.currentStateName || instance.currentStateId)}</div>
      <div style="font-size:11px;color:#8c8c8c;margin-top:4px;">状态ID: ${instance.currentStateId}</div>
      <div style="margin-top:8px;">
        <strong>上下文:</strong>
        <pre style="background:#f5f5f5;padding:8px;border-radius:4px;overflow:auto;max-height:120px;margin-top:4px;font-size:11px;">${escapeHtml(contextStr)}</pre>
      </div>
      ${instance.isFinal ? '<div style="margin-top:8px;color:#52c41a;font-weight:600;">🏁 已到达终态</div>' : ''}
    `;

    if (detail.stateDiagram) {
      this.drawTakeoverStateDiagram(detail.stateDiagram);
    }
  }

  drawTakeoverStateDiagram(diagram) {
    const canvas = document.getElementById('takeover-state-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    const width = canvas.width;
    const height = canvas.height;
    const padding = 40;
    
    ctx.clearRect(0, 0, width, height);
    
    const statePositions = new Map();
    const cols = Math.ceil(Math.sqrt(diagram.states.length));
    const rows = Math.ceil(diagram.states.length / cols);
    const cellW = (width - padding * 2) / cols;
    const cellH = (height - padding * 2) / rows;
    const stateRadius = Math.min(cellW, cellH) * 0.35;
    
    diagram.states.forEach((state, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = padding + col * cellW + cellW / 2;
      const y = padding + row * cellH + cellH / 2;
      statePositions.set(state.id, { x, y });
    });
    
    diagram.transitions.forEach(trans => {
      const from = statePositions.get(trans.from);
      const to = statePositions.get(trans.to);
      if (!from || !to) return;
      
      const angle = Math.atan2(to.y - from.y, to.x - from.x);
      const startX = from.x + stateRadius * Math.cos(angle);
      const startY = from.y + stateRadius * Math.sin(angle);
      const endX = to.x - stateRadius * Math.cos(angle);
      const endY = to.y - stateRadius * Math.sin(angle);
      
      ctx.strokeStyle = '#bfbfbf';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX, endY);
      ctx.stroke();
      
      const headLen = 8;
      ctx.fillStyle = '#bfbfbf';
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - headLen * Math.cos(angle - Math.PI/6), endY - headLen * Math.sin(angle - Math.PI/6));
      ctx.lineTo(endX - headLen * Math.cos(angle + Math.PI/6), endY - headLen * Math.sin(angle + Math.PI/6));
      ctx.closePath();
      ctx.fill();
      
      const midX = (startX + endX) / 2;
      const midY = (startY + endY) / 2;
      ctx.font = '10px sans-serif';
      ctx.fillStyle = '#595959';
      ctx.textAlign = 'center';
      ctx.fillText(trans.event, midX, midY - 5);
    });
    
    statePositions.forEach((pos, stateId) => {
      const state = diagram.states.find(s => s.id === stateId);
      const isCurrent = stateId === diagram.currentStateId;
      
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, stateRadius, 0, Math.PI * 2);
      ctx.fillStyle = isCurrent ? '#1890ff' : '#fff';
      ctx.fill();
      ctx.strokeStyle = isCurrent ? '#096dd9' : '#d9d9d9';
      ctx.lineWidth = isCurrent ? 3 : 2;
      ctx.stroke();
      
      ctx.fillStyle = isCurrent ? '#fff' : '#262626';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(state.name.slice(0, 8), pos.x, pos.y);
    });
  }

  renderTakeoverPendingEvents() {
    const detail = this.takeoverSessionDetail;
    const events = detail.pendingEvents || [];
    const container = document.getElementById('takeover-event-queue');

    if (events.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#8c8c8c;">暂无排队事件</div>';
      return;
    }

    container.innerHTML = events.map((e, idx) => `
      <div class="event-queue-item">
        <div class="event-queue-order">#${idx + 1}</div>
        <div class="event-queue-content">
          <div class="event-queue-header">
            <span class="event-queue-name">${escapeHtml(e.eventName)}</span>
            <span class="event-queue-time">${this.formatTime(e.receivedAt)}</span>
          </div>
          <pre class="event-queue-payload">${escapeHtml(JSON.stringify(e.payload, null, 2))}</pre>
        </div>
      </div>
    `).join('');
  }

  renderTakeoverHistory() {
    const detail = this.takeoverSessionDetail;
    const history = detail.flowHistory || [];
    const container = document.getElementById('takeover-history');

    if (history.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#8c8c8c;">暂无流转历史</div>';
      return;
    }

    container.innerHTML = history.map((step, idx) => `
      <div class="timeline-item ${idx === history.length - 1 ? 'active' : ''}">
        <div class="timeline-dot"></div>
        <div class="timeline-content">
          <div class="timeline-header">
            <span class="timeline-state">${escapeHtml(step.toStateName || step.toStateId)}</span>
            <span class="timeline-time">${this.formatTime(step.createdAt)}</span>
          </div>
          <div class="timeline-event">
            ${step.eventName ? `事件: <strong>${escapeHtml(step.eventName)}</strong>` : '初始状态'}
          </div>
          ${step.guardResult ? `
            <div class="timeline-detail">
              守卫: <span class="${step.guardResult.passed ? 'guard-pass' : 'guard-fail'}">
                ${step.guardResult.passed ? '✅ 通过' : '❌ 拦截'}
              </span>
            </div>
          ` : ''}
          ${step.complianceResult && step.complianceResult.blocked ? `
            <div class="timeline-detail violation">
              ⚠️ 合规拦截: ${step.complianceResult.violations?.length || 0} 项违规
            </div>
          ` : ''}
          ${step.isTimeout ? '<div class="timeline-detail timeout">⏰ 超时触发</div>' : ''}
        </div>
      </div>
    `).join('');
  }

  renderTakeoverActionLog() {
    const detail = this.takeoverSessionDetail;
    const actions = detail.actionLogs || [];
    const container = document.getElementById('takeover-action-log');

    if (actions.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#8c8c8c;">暂无处置记录</div>';
      return;
    }

    container.innerHTML = actions.map(action => `
      <div class="action-log-item">
        <div class="action-log-header">
          <span class="action-log-type ${action.actionType}">${this.getActionTypeLabel(action.actionType)}</span>
          <span class="action-log-operator">${escapeHtml(action.operatorName)}</span>
          <span class="action-log-time">${this.formatTime(action.createdAt)}</span>
        </div>
        <div class="action-log-content">${escapeHtml(action.description)}</div>
        ${action.previewStateId ? `
          <div class="action-log-detail">
            预览目标: ${escapeHtml(action.previewStateId || '')}
            ${action.previewAccepted ? ' · 可流转' : ' · 不可流转'}
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  getActionTypeLabel(type) {
    const labels = {
      'inject_event': '💉 注入事件',
      'jump_state': '⏭️ 跳过状态',
      'terminate': '🛑 终止实例',
      'modify_context': '✏️ 修改上下文',
      'resume': '▶️ 恢复自动',
      'unfreeze': '☀️ 完全解冻'
    };
    return labels[type] || type;
  }

  renderTakeoverActionPanel() {
    const tab = this.takeoverCurrentTab;
    const detail = this.takeoverSessionDetail;
    const instance = detail?.instance;

    document.querySelectorAll('.takeover-action-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`panel-${tab}`).style.display = 'block';

    if (tab === 'inject') {
      const events = detail?.availableEvents || [];
      const select = document.getElementById('takeover-inject-event');
      select.innerHTML = '<option value="">-- 选择事件 --</option>' +
        events.map(e => `<option value="${e}">${e}</option>`).join('');
      document.getElementById('takeover-inject-payload').value = '{}';
    } else if (tab === 'jump') {
      const states = detail?.reachableStates || [];
      const select = document.getElementById('takeover-jump-target');
      select.innerHTML = '<option value="">-- 选择目标状态 --</option>' +
        states.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    }

    document.getElementById('takeover-preview-result').innerHTML = '';
    this.takeoverPreviewResult = null;
  }

  previewTakeoverAction() {
    const tab = this.takeoverCurrentTab;
    const session = this.currentTakeoverSession;
    let actionData = {};

    if (tab === 'inject') {
      const event = document.getElementById('takeover-inject-event').value;
      const payloadStr = document.getElementById('takeover-inject-payload').value;
      if (!event) {
        toast('请选择事件', 'warning');
        return;
      }
      try {
        actionData = { event, payload: JSON.parse(payloadStr) };
      } catch (e) {
        toast('Payload 格式错误', 'error');
        return;
      }
    } else if (tab === 'jump') {
      const targetStateId = document.getElementById('takeover-jump-target').value;
      const reason = document.getElementById('takeover-jump-reason').value;
      if (!targetStateId) {
        toast('请选择目标状态', 'warning');
        return;
      }
      actionData = { targetStateId, reason };
    } else if (tab === 'terminate') {
      const reason = document.getElementById('takeover-terminate-reason').value;
      actionData = { reason: reason || '人工终止' };
    } else if (tab === 'context') {
      const contextStr = document.getElementById('takeover-context-data').value;
      try {
        actionData = { context: JSON.parse(contextStr) };
      } catch (e) {
        toast('上下文格式错误', 'error');
        return;
      }
    }

    fetch(`/api/takeover/sessions/${session.id}/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: tab,
        actionData: actionData
      })
    }).then(r => r.json()).then(result => {
      this.takeoverPreviewResult = result;
      this.renderPreviewResult(result);
    }).catch(e => {
      toast('预览失败: ' + e.message, 'error');
    });
  }

  renderPreviewResult(result) {
    const container = document.getElementById('takeover-preview-result');
    if (!result.success) {
      container.innerHTML = `
        <div class="preview-result error">
          <div class="preview-result-title">❌ 无法执行</div>
          <div class="preview-result-content">${escapeHtml(result.error || '未知错误')}</div>
        </div>
      `;
      return;
    }

    const prev = result.preview;
    let html = `<div class="preview-result ${prev.accepted ? 'success' : 'warning'}">`;
    html += `<div class="preview-result-title">${prev.accepted ? '✅ 可以执行' : '⚠️ 可能有问题'}</div>`;
    html += `<div class="preview-result-content">`;

    if (prev.targetStateId) {
      html += `<div><strong>目标状态:</strong> ${escapeHtml(prev.targetStateName || prev.targetStateId)}</div>`;
    }
    if (prev.willBeFinal) {
      html += `<div style="color:#52c41a;">🏁 将到达终态</div>`;
    }
    if (prev.hasTransitions) {
      html += `<div>➡️ 将触发 ${prev.transitionCount || 0} 次状态流转</div>`;
    }
    if (prev.complianceIssues && prev.complianceIssues.length > 0) {
      html += `<div style="color:#cf1322;margin-top:8px;">⚠️ 合规风险 (${prev.complianceIssues.length} 项):</div>`;
      prev.complianceIssues.forEach(issue => {
        html += `<div style="font-size:11px;color:#cf1322;margin-left:12px;">• ${escapeHtml(issue.message)}</div>`;
      });
    }
    if (prev.warnings && prev.warnings.length > 0) {
      html += `<div style="color:#d46b08;margin-top:8px;">⚠️ 警告:</div>`;
      prev.warnings.forEach(w => {
        html += `<div style="font-size:11px;color:#d46b08;margin-left:12px;">• ${escapeHtml(w)}</div>`;
      });
    }
    if (prev.pendingEventsAfter > 0) {
      html += `<div style="margin-top:8px;">📥 恢复后将处理 ${prev.pendingEventsAfter} 条排队事件</div>`;
    }

    html += `</div></div>`;
    container.innerHTML = html;
  }

  executeTakeoverAction() {
    if (!this.takeoverPreviewResult || !this.takeoverPreviewResult.success) {
      toast('请先预览处置效果', 'warning');
      return;
    }

    const tab = this.takeoverCurrentTab;
    const session = this.currentTakeoverSession;
    let actionData = {};
    let description = '';

    if (tab === 'inject') {
      const event = document.getElementById('takeover-inject-event').value;
      const payloadStr = document.getElementById('takeover-inject-payload').value;
      const reason = document.getElementById('takeover-inject-reason').value;
      actionData = { event, payload: JSON.parse(payloadStr), reason };
      description = `注入事件 "${event}"${reason ? `: ${reason}` : ''}`;
    } else if (tab === 'jump') {
      const targetStateId = document.getElementById('takeover-jump-target').value;
      const reason = document.getElementById('takeover-jump-reason').value;
      const targetStateName = document.querySelector(`#takeover-jump-target option[value="${targetStateId}"]`)?.textContent || targetStateId;
      actionData = { targetStateId, reason };
      description = `跳转到 "${targetStateName}"${reason ? `: ${reason}` : ''}`;
    } else if (tab === 'terminate') {
      const reason = document.getElementById('takeover-terminate-reason').value;
      actionData = { reason: reason || '人工终止' };
      description = `终止实例: ${actionData.reason}`;
    } else if (tab === 'context') {
      const contextStr = document.getElementById('takeover-context-data').value;
      const reason = document.getElementById('takeover-context-reason').value;
      actionData = { context: JSON.parse(contextStr), reason };
      description = `修改上下文${reason ? `: ${reason}` : ''}`;
    }

    if (!confirm(`确认执行: ${description}?`)) return;

    fetch(`/api/takeover/sessions/${session.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName,
        actionType: tab,
        actionData: actionData,
        description: description,
        previewResult: this.takeoverPreviewResult.preview
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        toast('✅ 处置已执行', 'success');
        this.takeoverPreviewResult = null;
        document.getElementById('takeover-preview-result').innerHTML = '';
        this.loadTakeoverSessionDetail(session.id);
      } else {
        toast(result.error || '执行失败', 'error');
      }
    }).catch(e => {
      toast('执行失败: ' + e.message, 'error');
    });
  }

  resumeInstance() {
    if (!confirm('确认恢复自动运行？排队事件将按顺序继续处理。')) return;

    const session = this.currentTakeoverSession;
    fetch(`/api/takeover/sessions/${session.id}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        toast('▶️ 实例已恢复自动运行', 'success');
        this.loadTakeoverSessionDetail(session.id);
      } else {
        toast(result.error || '恢复失败', 'error');
      }
    });
  }

  unfreezeInstance() {
    if (!confirm('确认完全解冻并结束接管？实例将恢复正常运行。')) return;

    const session = this.currentTakeoverSession;
    fetch(`/api/takeover/sessions/${session.id}/unfreeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operatorId: this.takeoverOperatorId,
        operatorName: this.takeoverOperatorName
      })
    }).then(r => r.json()).then(result => {
      if (result.success) {
        toast('☀️ 实例已完全解冻', 'success');
        this.currentTakeoverSession = null;
        this.showTakeoverDashboard();
      } else {
        toast(result.error || '解冻失败', 'error');
      }
    });
  }

  formatTime(isoString) {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString);
      return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (e) {
      return isoString;
    }
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new WorkflowApp();
  window.simulationLab = new SimulationLab();
});
