// Reloj circular con N oportunidades. Leer estadísticas no cuenta como uso:
// solamente touch() recarga el contador. No hay temporizadores de expiración.
export class NthChanceClock {
  constructor(capacity, onEvict = () => {}) {
    this.checkCapacity(capacity);
    this.slots = Array(capacity).fill(null);
    this.index = new Map();
    this.hand = 0;
    this.onEvict = onEvict;
    this.scans = 0;
    this.replacements = 0;
  }

  checkCapacity(capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError('Capacidad de reloj inválida.');
  }
  get capacity() { return this.slots.length; }
  get size() { return this.index.size; }
  has(key) { return this.index.has(key); }
  get(key) { return this.slots[this.index.get(key)]?.value; }
  *entries() { for (const entry of this.slots) if (entry) yield [entry.key, entry.value]; }

  touch(key, chances = 1) {
    if (!Number.isSafeInteger(chances) || chances < 1) throw new RangeError('Oportunidades inválidas.');
    const entry = this.slots[this.index.get(key)];
    if (!entry) return false;
    entry.remaining = chances;
    return true;
  }

  // Las páginas de trabajo vigentes están fijadas. Si todas están fijadas,
  // se rechaza la admisión: nunca se gira indefinidamente ni se excede el cupo.
  victim(protectedKeys) {
    const candidates = this.slots.filter(entry => entry && !protectedKeys.has(entry.key));
    if (!candidates.length) return -1;
    const rounds = Math.max(...candidates.map(entry => entry.remaining)) + 1;
    for (let scanned = 0; scanned < rounds * this.capacity; scanned++) {
      const position = this.hand;
      this.hand = (this.hand + 1) % this.capacity;
      this.scans++;
      const entry = this.slots[position];
      if (!entry) continue;
      if (entry.remaining > 0) entry.remaining--;
      else if (!protectedKeys.has(entry.key)) return position;
    }
    return -1;
  }

  put(key, value, chances = 1, protectedKeys = new Set()) {
    if (this.has(key)) { this.touch(key, chances); return true; }
    if (!Number.isSafeInteger(chances) || chances < 1) throw new RangeError('Oportunidades inválidas.');
    let position = -1;
    // Se usan primero los huecos libres; sin presión no envejecemos entradas.
    for (let offset = 0; offset < this.capacity; offset++) {
      const candidate = (this.hand + offset) % this.capacity;
      if (!this.slots[candidate]) { position = candidate; break; }
    }
    if (position < 0) position = this.victim(protectedKeys);
    if (position < 0) return false;
    const old = this.slots[position];
    if (old) { this.delete(old.key, 'replacement'); this.replacements++; }
    this.slots[position] = { key, value, remaining: chances };
    this.index.set(key, position);
    this.hand = (position + 1) % this.capacity;
    return true;
  }

  delete(key, reason = 'clear') {
    const position = this.index.get(key);
    if (position === undefined) return false;
    const entry = this.slots[position];
    this.slots[position] = null;
    this.index.delete(key);
    this.onEvict(entry.key, entry.value, reason);
    return true;
  }

  resize(capacity, protectedKeys = new Set()) {
    this.checkCapacity(capacity);
    if (capacity === this.capacity) return;
    const protectedCount = [...this.index.keys()].filter(key => protectedKeys.has(key)).length;
    if (protectedCount > capacity) throw new RangeError('El conjunto protegido supera el cupo del reloj.');
    while (this.size > capacity) {
      const position = this.victim(protectedKeys);
      this.delete(this.slots[position].key, 'resize');
      this.replacements++;
    }
    // Preserva el orden circular a partir de la mano, los objetos y sus N.
    const entries = [];
    for (let i = 0; i < this.capacity; i++) {
      const entry = this.slots[(this.hand + i) % this.capacity];
      if (entry) entries.push(entry);
    }
    this.slots = [...entries, ...Array(capacity - entries.length).fill(null)];
    this.index = new Map(entries.map((entry, index) => [entry.key, index]));
    this.hand = 0;
  }

  clear() {
    for (const key of [...this.index.keys()]) this.delete(key);
    this.hand = 0;
  }

  inspect(protectedKeys = new Set()) {
    return {
      size: this.size, capacity: this.capacity, hand: this.hand,
      scans: this.scans, replacements: this.replacements,
      slots: this.slots.map(entry => entry ? {
        key: entry.key, remaining: entry.remaining, protected: protectedKeys.has(entry.key),
      } : null),
    };
  }
}
