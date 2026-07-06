const { calcularProximoDiaMes, calcularVencimientoSub } = require('../db');

// Tests unitarios puros (sin DB) del modo de vencimiento "día fijo del mes".
describe('calcularProximoDiaMes: día fijo del mes', () => {
  it('si el día aún no pasó, vence ese día del mes de emisión', () => {
    expect(calcularProximoDiaMes('2026-07-01', 14)).toBe('2026-07-14');
    expect(calcularProximoDiaMes('2026-07-10', 14)).toBe('2026-07-14');
  });

  it('emitida el mismo día objetivo → vence ese mismo día (no salta de mes)', () => {
    expect(calcularProximoDiaMes('2026-07-14', 14)).toBe('2026-07-14');
  });

  it('si el día ya pasó, vence ese día del mes siguiente', () => {
    expect(calcularProximoDiaMes('2026-07-15', 14)).toBe('2026-08-14');
    expect(calcularProximoDiaMes('2026-07-31', 14)).toBe('2026-08-14');
  });

  it('cruce de año: diciembre → enero del año siguiente', () => {
    expect(calcularProximoDiaMes('2026-12-20', 14)).toBe('2027-01-14');
  });

  it('mes destino sin ese día → se ajusta al último día del mes', () => {
    // día 31 emitida en febrero (28 días) → 28-feb
    expect(calcularProximoDiaMes('2026-02-10', 31)).toBe('2026-02-28');
    // día 31 emitida en abril (30 días) → 30-abr
    expect(calcularProximoDiaMes('2026-04-05', 31)).toBe('2026-04-30');
    // día 30 emitida en febrero → 28-feb
    expect(calcularProximoDiaMes('2026-02-05', 30)).toBe('2026-02-28');
  });

  it('año bisiesto: día 31 en febrero 2028 → 29-feb', () => {
    expect(calcularProximoDiaMes('2028-02-10', 31)).toBe('2028-02-29');
  });

  it('ajuste al último día también cuando el objetivo ya pasó y salta al mes corto', () => {
    // emitida 31-ene, día objetivo 30: 30 < 31 → salta a febrero, febrero no tiene 30 → 28-feb
    expect(calcularProximoDiaMes('2026-01-31', 30)).toBe('2026-02-28');
  });

  it('valida el rango del día (1-31); fuera de rango o inválido → null', () => {
    expect(calcularProximoDiaMes('2026-07-01', 0)).toBeNull();
    expect(calcularProximoDiaMes('2026-07-01', 32)).toBeNull();
    expect(calcularProximoDiaMes('2026-07-01', null)).toBeNull();
  });
});

describe('calcularVencimientoSub: enrutado por modo_vencimiento', () => {
  it("modo 'dia_mes' usa dia_mes_vencimiento", () => {
    const sub = { modo_vencimiento: 'dia_mes', dia_mes_vencimiento: 14 };
    expect(calcularVencimientoSub('2026-07-15', sub)).toBe('2026-08-14');
  });

  it("modo 'dia_mes' sin día configurado → null", () => {
    const sub = { modo_vencimiento: 'dia_mes', dia_mes_vencimiento: null };
    expect(calcularVencimientoSub('2026-07-15', sub)).toBeNull();
  });

  it("modo 'dias' sigue funcionando (no lo afecta el nuevo modo)", () => {
    const sub = { modo_vencimiento: 'dias', dia_vencimiento: 30 };
    expect(calcularVencimientoSub('2026-07-01', sub)).toBe('2026-07-31');
  });
});
