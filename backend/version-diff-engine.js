const DIFF_TYPE = {
  ADDED: 'added',
  REMOVED: 'removed',
  MODIFIED: 'modified'
};

const RISK_LEVEL = {
  SAFE: 'safe',
  ATTENTION: 'attention',
  DANGEROUS: 'dangerous'
};

function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  
  if (typeof a !== 'object') return a === b;
  
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  
  if (Array.isArray(a) || Array.isArray(b)) return false;
  
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  for (const key of keysA) {
    if (!keysB.includes(key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  
  return true;
}

function buildStateMap(states) {
  const byId = new Map();
  const byName = new Map();
  for (const s of states) {
    byId.set(s.id, s);
    if (s.name) {
      byName.set(s.name, s);
    }
  }
  return { byId, byName };
}

function buildTransitionMaps(transitions, oldStateNameById, newStateNameById) {
  const byFullKey = new Map();
  const bySourceEvent = new Map();
  const byId = new Map();

  for (const t of transitions) {
    const fullKey = `${t.sourceStateId}:${t.targetStateId}:${t.event}`;
    byFullKey.set(fullKey, t);
    byId.set(t.id, t);

    const srcEventKey = `${t.sourceStateId}:${t.event}`;
    if (!bySourceEvent.has(srcEventKey)) {
      bySourceEvent.set(srcEventKey, []);
    }
    bySourceEvent.get(srcEventKey).push(t);
  }

  return { byFullKey, bySourceEvent, byId };
}

function compareStateProps(oldState, newState) {
  const changes = [];
  const propsToCompare = ['name', 'isInitial', 'isFinal', 'timeout'];
  
  for (const prop of propsToCompare) {
    const oldVal = oldState[prop];
    const newVal = newState[prop];
    
    if (!deepEqual(oldVal, newVal)) {
      changes.push({
        property: prop,
        oldValue: oldVal,
        newValue: newVal
      });
    }
  }
  
  return changes;
}

function compareTransitionProps(oldTransition, newTransition) {
  const changes = [];
  const propsToCompare = ['guard', 'sourceStateId', 'targetStateId', 'event'];
  
  for (const prop of propsToCompare) {
    const oldVal = oldTransition[prop];
    const newVal = newTransition[prop];
    
    if (!deepEqual(oldVal, newVal)) {
      changes.push({
        property: prop,
        oldValue: oldVal,
        newValue: newVal
      });
    }
  }
  
  return changes;
}

function diffStates(oldStates, newStates) {
  const oldMaps = buildStateMap(oldStates);
  const newMaps = buildStateMap(newStates);

  const oldMatched = new Set();
  const newMatched = new Set();

  const added = [];
  const removed = [];
  const modified = [];

  for (const newState of newStates) {
    let oldState = null;
    let matchType = null;

    if (oldMaps.byId.has(newState.id)) {
      oldState = oldMaps.byId.get(newState.id);
      matchType = 'id';
    } else if (newState.name && oldMaps.byName.has(newState.name)) {
      oldState = oldMaps.byName.get(newState.name);
      matchType = 'name';
    }

    if (oldState) {
      oldMatched.add(oldState.id);
      newMatched.add(newState.id);

      const changes = compareStateProps(oldState, newState);
      if (matchType === 'name') {
        changes.unshift({
          property: 'id',
          oldValue: oldState.id,
          newValue: newState.id
        });
      }

      if (changes.length > 0) {
        modified.push({
          type: DIFF_TYPE.MODIFIED,
          entityType: 'state',
          id: newState.id,
          oldId: oldState.id,
          name: newState.name,
          matchType,
          oldValue: oldState,
          newValue: newState,
          changes
        });
      }
    } else {
      added.push({
        type: DIFF_TYPE.ADDED,
        entityType: 'state',
        id: newState.id,
        name: newState.name,
        newValue: newState
      });
    }
  }

  for (const oldState of oldStates) {
    if (!oldMatched.has(oldState.id)) {
      removed.push({
        type: DIFF_TYPE.REMOVED,
        entityType: 'state',
        id: oldState.id,
        name: oldState.name,
        oldValue: oldState
      });
    }
  }

  return { added, removed, modified };
}

function buildStateIdMappings(oldStates, newStates) {
  const oldIdToName = new Map();
  const oldNameToId = new Map();
  const newIdToName = new Map();
  const newNameToId = new Map();

  for (const s of oldStates) {
    oldIdToName.set(s.id, s.name);
    if (s.name) oldNameToId.set(s.name, s.id);
  }
  for (const s of newStates) {
    newIdToName.set(s.id, s.name);
    if (s.name) newNameToId.set(s.name, s.id);
  }

  return { oldIdToName, oldNameToId, newIdToName, newNameToId };
}

function findMatchingTransition(newTransition, oldTransitionsUnmatched, stateMappings) {
  const { oldIdToName, oldNameToId, newIdToName } = stateMappings;

  const srcName = newIdToName.get(newTransition.sourceStateId);
  const tgtName = newIdToName.get(newTransition.targetStateId);

  let bestMatch = null;
  let bestMatchScore = 0;

  for (const oldT of oldTransitionsUnmatched) {
    let score = 0;
    const oldSrcName = oldIdToName.get(oldT.sourceStateId);
    const oldTgtName = oldIdToName.get(oldT.targetStateId);

    if (oldT.id === newTransition.id) {
      score = Math.max(score, 1000);
    }

    if (oldT.sourceStateId === newTransition.sourceStateId && oldT.event === newTransition.event) {
      score = Math.max(score, 500);
    }

    if (srcName && oldSrcName === srcName && oldT.event === newTransition.event) {
      score = Math.max(score, 400);
    }

    if (oldT.sourceStateId === newTransition.sourceStateId &&
        oldT.targetStateId === newTransition.targetStateId &&
        oldT.event === newTransition.event) {
      score = Math.max(score, 600);
    }

    if (srcName && oldSrcName === srcName &&
        tgtName && oldTgtName === tgtName &&
        oldT.event === newTransition.event) {
      score = Math.max(score, 450);
    }

    if (score > bestMatchScore) {
      bestMatchScore = score;
      bestMatch = oldT;
    }
  }

  return bestMatchScore > 0 ? bestMatch : null;
}

function diffTransitions(oldTransitions, newTransitions, oldStates, newStates) {
  const stateMappings = buildStateIdMappings(oldStates, newStates);

  const oldUnmatched = [...oldTransitions];
  const newUnmatched = [...newTransitions];
  const oldToNewPairs = [];

  for (let i = 0; i < newUnmatched.length; i++) {
    const newT = newUnmatched[i];
    const match = findMatchingTransition(newT, oldUnmatched, stateMappings);
    if (match) {
      const idx = oldUnmatched.indexOf(match);
      if (idx >= 0) {
        oldUnmatched.splice(idx, 1);
      }
      oldToNewPairs.push({ oldT: match, newT });
      newUnmatched.splice(i, 1);
      i--;
    }
  }

  const added = [];
  const removed = [];
  const modified = [];

  for (const pair of oldToNewPairs) {
    const { oldT, newT } = pair;
    const changes = compareTransitionProps(oldT, newT);

    if (oldT.sourceStateId !== newT.sourceStateId) {
      const existingSrc = changes.find(c => c.property === 'sourceStateId');
      if (!existingSrc) {
        changes.unshift({
          property: 'sourceStateId',
          oldValue: oldT.sourceStateId,
          newValue: newT.sourceStateId
        });
      }
    }
    if (oldT.targetStateId !== newT.targetStateId) {
      const existingTgt = changes.find(c => c.property === 'targetStateId');
      if (!existingTgt) {
        const idx = changes.findIndex(c => c.property === 'sourceStateId');
        const insertIdx = idx >= 0 ? idx + 1 : 0;
        changes.splice(insertIdx, 0, {
          property: 'targetStateId',
          oldValue: oldT.targetStateId,
          newValue: newT.targetStateId
        });
      }
    }
    if (oldT.event !== newT.event) {
      const existingEv = changes.find(c => c.property === 'event');
      if (!existingEv) {
        changes.unshift({
          property: 'event',
          oldValue: oldT.event,
          newValue: newT.event
        });
      }
    }

    if (changes.length > 0) {
      modified.push({
        type: DIFF_TYPE.MODIFIED,
        entityType: 'transition',
        id: newT.id,
        oldId: oldT.id,
        event: newT.event,
        oldEvent: oldT.event,
        sourceStateId: newT.sourceStateId,
        oldSourceStateId: oldT.sourceStateId,
        targetStateId: newT.targetStateId,
        oldTargetStateId: oldT.targetStateId,
        oldValue: oldT,
        newValue: newT,
        changes
      });
    }
  }

  for (const newT of newUnmatched) {
    added.push({
      type: DIFF_TYPE.ADDED,
      entityType: 'transition',
      id: newT.id,
      event: newT.event,
      sourceStateId: newT.sourceStateId,
      targetStateId: newT.targetStateId,
      newValue: newT
    });
  }

  for (const oldT of oldUnmatched) {
    removed.push({
      type: DIFF_TYPE.REMOVED,
      entityType: 'transition',
      id: oldT.id,
      event: oldT.event,
      sourceStateId: oldT.sourceStateId,
      targetStateId: oldT.targetStateId,
      oldValue: oldT
    });
  }

  return { added, removed, modified };
}

function compareDefinitions(oldDefinition, newDefinition) {
  const stateDiff = diffStates(oldDefinition.states, newDefinition.states);
  const transitionDiff = diffTransitions(
    oldDefinition.transitions,
    newDefinition.transitions,
    oldDefinition.states,
    newDefinition.states
  );
  
  const allDiffs = [
    ...stateDiff.added,
    ...stateDiff.removed,
    ...stateDiff.modified,
    ...transitionDiff.added,
    ...transitionDiff.removed,
    ...transitionDiff.modified
  ];
  
  const summary = {
    states: {
      added: stateDiff.added.length,
      removed: stateDiff.removed.length,
      modified: stateDiff.modified.length
    },
    transitions: {
      added: transitionDiff.added.length,
      removed: transitionDiff.removed.length,
      modified: transitionDiff.modified.length
    },
    totalChanges: allDiffs.length
  };
  
  return {
    summary,
    states: stateDiff,
    transitions: transitionDiff,
    hasChanges: allDiffs.length > 0
  };
}

function compareMachines(oldMachine, newMachine) {
  if (oldMachine.name !== newMachine.name) {
    throw new Error('只能比较同名状态机的不同版本');
  }
  
  const diffResult = compareDefinitions(oldMachine.definition, newMachine.definition);
  
  return {
    oldVersion: {
      id: oldMachine.id,
      name: oldMachine.name,
      version: oldMachine.version,
      createdAt: oldMachine.createdAt
    },
    newVersion: {
      id: newMachine.id,
      name: newMachine.name,
      version: newMachine.version,
      createdAt: newMachine.createdAt
    },
    ...diffResult
  };
}

module.exports = {
  DIFF_TYPE,
  RISK_LEVEL,
  compareDefinitions,
  compareMachines,
  diffStates,
  diffTransitions,
  deepEqual
};
