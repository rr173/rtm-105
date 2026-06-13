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
        (inst.isFinal ? ' final' : '');
      
      let versionBadge = '';
      if (inst.machineVersion !== undefined && latestVersion !== null) {
        if (inst.machineVersion < latestVersion) {
          versionBadge = `<span class="instance-version-badge outdated">v${inst.machineVersion}</span>`;
        } else {
          versionBadge = `<span class="instance-version-badge latest">v${inst.machineVersion}</span>`;
        }
      }
      
      return `<div class="${cls}" data-id="${inst.id}">
        ${inst.id.slice(0, 8)}… [${stateName}]${versionBadge}
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
    
    detail.innerHTML = `
      <div><strong>实例ID:</strong> ${inst.id}</div>
      <div><strong>当前状态:</strong> <span style="color:#1890ff;font-weight:600;">${stateName}</span>${inst.isFinal ? ' <span class="badge badge-active">终态</span>' : ''}</div>
      ${versionInfo}
      <div><strong>创建时间:</strong> ${new Date(inst.createdAt).toLocaleString()}</div>
      <div><strong>上下文:</strong> <code style="background:#f5f5f5;padding:2px 6px;border-radius:3px;">${JSON.stringify(inst.context)}</code></div>
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
            v${m.version} ${m.version > sourceMachine.version ? '(更新)' : '(更旧')} · ${new Date(m.createdAt).toLocaleString()}
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

window.addEventListener('DOMContentLoaded', () => {
  window.app = new WorkflowApp();
});
