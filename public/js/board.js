/**
 * 윷판 SVG 렌더러. 서버 game.js 의 노드 번호 체계를 그대로 따른다.
 *  - 바깥 둘레 1~19, 출발/도착 20, 중앙 23, 지름길 21·22·24·25 / 26·27·28·29
 */
const SIZE = 600;
const STEP = 96;
const MIN = 60;
const MAX = 540;
const MID = 300;
const START_NODE = 20;
const CENTER_NODE = 23;
const BIG_NODES = new Set([5, 10, 15, 20, 23]);
/** 같은 칸에 도착하는 선택지가 여럿일 때 표시를 벌리는 간격 */
const DUPLICATE_HINT_GAP = 34;
const SVG_NS = 'http://www.w3.org/2000/svg';

export const NODE_POSITIONS = buildPositions();

function buildPositions() {
  const positions = {};
  for (let k = 1; k <= 4; k += 1) {
    positions[k] = { x: MAX, y: MAX - STEP * k };
    positions[5 + k] = { x: MAX - STEP * k, y: MIN };
    positions[10 + k] = { x: MIN, y: MIN + STEP * k };
    positions[15 + k] = { x: MIN + STEP * k, y: MAX };
  }
  positions[5] = { x: MAX, y: MIN };
  positions[10] = { x: MIN, y: MIN };
  positions[15] = { x: MIN, y: MAX };
  positions[START_NODE] = { x: MAX, y: MAX };
  // 5 → 중앙 → 15 대각선
  positions[21] = { x: 460, y: 140 };
  positions[22] = { x: 380, y: 220 };
  positions[CENTER_NODE] = { x: MID, y: MID };
  positions[24] = { x: 220, y: 380 };
  positions[25] = { x: 140, y: 460 };
  // 10 → 중앙 → 20 대각선
  positions[26] = { x: 140, y: 140 };
  positions[27] = { x: 220, y: 220 };
  positions[28] = { x: 380, y: 380 };
  positions[29] = { x: 460, y: 460 };
  return positions;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    node.append(child);
  }
  return node;
}

/**
 * @param {(option: object) => void} onSelect 말 선택 콜백
 */
export function createBoard(onSelect) {
  const svg = el('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, class: 'yut-board', role: 'img', 'aria-label': '윷판' });
  const linesLayer = el('g', { class: 'board-lines' });
  const nodesLayer = el('g', { class: 'board-nodes' });
  const hintsLayer = el('g', { class: 'board-hints' });
  const piecesLayer = el('g', { class: 'board-pieces' });
  const labelsLayer = el('g', { class: 'board-labels' });
  svg.append(linesLayer, nodesLayer, labelsLayer, hintsLayer, piecesLayer);

  drawLines(linesLayer);
  drawNodes(nodesLayer);
  drawLabels(labelsLayer);

  const pieceElements = new Map();

  svg.addEventListener('click', (event) => {
    const target = event.target.closest('[data-option]');
    if (!target) {
      return;
    }
    onSelect(JSON.parse(target.dataset.option));
  });

  function update(room, { options = [], canAct = false, actingTeam = null } = {}) {
    updatePieces(room);
    updateHints(room, options, canAct, actingTeam);
  }

  function updatePieces(room) {
    const seen = new Set();
    for (const team of room.teams) {
      const groups = groupByNode(team.pieces);
      for (const [node, pieces] of groups) {
        pieces.forEach((piece, depth) => {
          seen.add(piece.id);
          const element = ensurePiece(piece.id, team);
          placePiece(element, node, depth, pieces.length, piece.done);
        });
      }
    }
    for (const [id, element] of pieceElements) {
      if (!seen.has(id)) {
        element.remove();
        pieceElements.delete(id);
      }
    }
  }

  function ensurePiece(id, team) {
    let element = pieceElements.get(id);
    if (!element) {
      element = el('g', { class: 'piece', 'data-piece-id': id }, [
        el('circle', { class: 'piece-ring', r: 26 }),
        el('circle', { class: 'piece-body', r: 21 }),
        el('text', { class: 'piece-emoji', y: 2, 'text-anchor': 'middle', 'dominant-baseline': 'central' }),
        el('g', { class: 'piece-badge' }, [
          el('circle', { r: 11, cx: 17, cy: -17 }),
          el('text', { x: 17, y: -16, 'text-anchor': 'middle', 'dominant-baseline': 'central' }),
        ]),
      ]);
      piecesLayer.append(element);
      pieceElements.set(id, element);
    }
    element.querySelector('.piece-body').setAttribute('fill', team.color);
    element.querySelector('.piece-emoji').textContent = team.emoji;
    return element;
  }

  function placePiece(element, node, depth, stackSize, done) {
    const onBoard = node !== null && !done;
    const position = onBoard ? NODE_POSITIONS[node] : NODE_POSITIONS[START_NODE];
    const offset = onBoard ? depth * -5 : 0;
    element.style.transform = `translate(${position.x + offset}px, ${position.y + offset}px)`;
    element.classList.toggle('hidden', !onBoard);
    const isTop = depth === stackSize - 1;
    const badge = element.querySelector('.piece-badge');
    badge.classList.toggle('hidden', !(isTop && stackSize > 1));
    badge.querySelector('text').textContent = String(stackSize);
    // 위에 놓인 말이 항상 마지막에 그려지도록
    if (isTop && onBoard) {
      piecesLayer.append(element);
    }
  }

  function updateHints(room, options, canAct, actingTeam) {
    hintsLayer.replaceChildren();
    for (const element of pieceElements.values()) {
      element.classList.remove('selectable');
      delete element.dataset.option;
    }
    if (!room.turn || room.turn.phase !== 'MOVE' || options.length === 0) {
      return;
    }
    const team = actingTeam ?? room.teams[room.turn.teamIndex];
    // 서로 다른 말이 같은 칸에 도착하는 선택지는 표시를 옆으로 벌리고 출발 칸 번호를 붙여 구분한다
    const destKeys = options.map((option) => destKeyOf(option));
    const destCounts = new Map();
    for (const key of destKeys) {
      destCounts.set(key, (destCounts.get(key) ?? 0) + 1);
    }
    const destSeen = new Map();
    options.forEach((option, optionIndex) => {
      const optionData = JSON.stringify({ kind: option.kind, node: option.node });
      const destKey = destKeys[optionIndex];
      const duplicates = destCounts.get(destKey);
      const order = destSeen.get(destKey) ?? 0;
      destSeen.set(destKey, order + 1);
      const offsetX = duplicates > 1 ? (order - (duplicates - 1) / 2) * DUPLICATE_HINT_GAP : 0;
      const destPosition = NODE_POSITIONS[option.dest.done || option.dest.node === null ? START_NODE : option.dest.node];
      const icon = option.dest.done ? '🏁' : option.dest.node === null ? '🏠' : opponentAt(room, team.index, option.dest.node) ? '😈' : '⭐';
      const markerChildren = [
        el('circle', { r: 27, fill: team.color, 'fill-opacity': 0.25, stroke: team.color, 'stroke-width': 3, 'stroke-dasharray': '6 5' }),
        el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'hint-text' }, [document.createTextNode(icon)]),
      ];
      if (duplicates > 1 && option.node !== null) {
        markerChildren.push(
          el('text', { y: 22, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'hint-source' }, [
            document.createTextNode(`${option.node}번`),
          ]),
        );
      }
      const marker = el('g', { class: `hint-dest ${canAct ? 'clickable' : ''}`, 'data-option': canAct ? optionData : null }, markerChildren);
      marker.style.transform = `translate(${destPosition.x + offsetX}px, ${destPosition.y}px)`;
      hintsLayer.append(marker);

      if (option.kind === 'new') {
        const start = NODE_POSITIONS[START_NODE];
        const token = el('g', { class: `hint-new ${canAct ? 'clickable selectable' : ''}`, 'data-option': canAct ? optionData : null }, [
          el('circle', { class: 'piece-ring', r: 26 }),
          el('circle', { r: 21, fill: team.color, stroke: '#fff', 'stroke-width': 3 }),
          el('text', { 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'hint-plus' }, [document.createTextNode('+')]),
        ]);
        token.style.transform = `translate(${start.x}px, ${start.y}px)`;
        hintsLayer.append(token);
      } else {
        for (const pieceId of option.pieceIds) {
          const element = pieceElements.get(pieceId);
          if (element && canAct) {
            element.classList.add('selectable');
            element.dataset.option = optionData;
          }
        }
      }
    });
  }

  return { svg, update };
}

function destKeyOf(option) {
  if (option.dest.done) {
    return 'done';
  }
  return option.dest.node === null ? 'home' : String(option.dest.node);
}

function opponentAt(room, teamIndex, node) {
  if (node === null || node === undefined) {
    return false;
  }
  return room.teams.some((team) => team.index !== teamIndex && team.pieces.some((piece) => piece.node === node && !piece.done));
}

function groupByNode(pieces) {
  const groups = new Map();
  for (const piece of pieces) {
    const key = piece.done ? 'done' : piece.node;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(piece);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.id.localeCompare(b.id));
  }
  return [...groups.entries()].map(([key, group]) => [key === 'done' || key === null ? null : key, group]);
}

function drawLines(layer) {
  layer.append(
    el('rect', { x: MIN, y: MIN, width: MAX - MIN, height: MAX - MIN, class: 'board-square' }),
    el('line', { x1: MAX, y1: MIN, x2: MIN, y2: MAX, class: 'board-diagonal' }),
    el('line', { x1: MIN, y1: MIN, x2: MAX, y2: MAX, class: 'board-diagonal' }),
  );
}

function drawNodes(layer) {
  for (const [node, position] of Object.entries(NODE_POSITIONS)) {
    const id = Number(node);
    const big = BIG_NODES.has(id);
    const group = el('g', { class: `board-node ${big ? 'big' : ''}`, 'data-node': id });
    group.append(el('circle', { cx: position.x, cy: position.y, r: big ? 18 : 12 }));
    if (id !== START_NODE) {
      group.append(
        el('text', { x: position.x, y: position.y, 'text-anchor': 'middle', 'dominant-baseline': 'central', class: 'node-number' }, [
          document.createTextNode(String(id === CENTER_NODE ? '방' : id)),
        ]),
      );
    }
    layer.append(group);
  }
}

function drawLabels(layer) {
  const start = NODE_POSITIONS[START_NODE];
  layer.append(
    el('text', { x: start.x, y: start.y + 42, 'text-anchor': 'middle', class: 'board-label' }, [document.createTextNode('출발 · 도착')]),
    el('text', { x: NODE_POSITIONS[5].x, y: NODE_POSITIONS[5].y - 30, 'text-anchor': 'middle', class: 'board-label small' }, [
      document.createTextNode('지름길 ↙'),
    ]),
    el('text', { x: NODE_POSITIONS[10].x, y: NODE_POSITIONS[10].y - 30, 'text-anchor': 'middle', class: 'board-label small' }, [
      document.createTextNode('지름길 ↘'),
    ]),
  );
}
