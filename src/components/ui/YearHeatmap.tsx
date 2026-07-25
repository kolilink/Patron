import React, { useEffect, useMemo, useRef, useState } from 'react';
import { GestureResponderEvent, InteractionManager, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import { useTheme } from '@/src/theme';
import { spacing, radius, shadow } from '@/src/theme';
import type { Palette } from '@/src/theme';
import { Text } from './Text';
import type { DailyPoint } from '@/stores/rapports';

// Same grid logic as the GitHub/Skool-style contribution graph — Monday-first
// rows (row 0 = Mon … row 6 = Sun, labeled at rows 0/2/4/6 exactly like the
// reference), one column per week, month labels above the column where that
// month starts. Coloring is our own: 3 flat levels off the app's success
// token (never a copy of Skool's palette), not a 5-step scale.
const CELL = 11;
const GAP = 3;
const STEP = CELL + GAP;
const ROWS = 7;
const ROW_LABELS: Record<number, string> = { 0: 'Lun', 2: 'Mer', 4: 'Ven', 6: 'Dim' };
const MONTH_LABELS_FR = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Jun', 'Jul', 'Aoû', 'Sep', 'Oct', 'Nov', 'Déc'];
const MONTH_ROW_HEIGHT = 16;
const TOOLTIP_W = 172;
const TOOLTIP_AUTO_HIDE_MS = 3000;

interface Cell {
  date: string;
  col: number;
  row: number;
  amount: number;
  salesCount: number;
}

interface Tooltip {
  cell: Cell;
  left: number;
  top: number;
}

interface YearHeatmapProps {
  year: number;
  data: DailyPoint[];
  highlightRange?: { start: string; end: string } | null;
  defaultMonth?: number;
}

function mondayFirstDow(date: Date): number {
  return (date.getDay() + 6) % 7; // 0=Mon..6=Sun
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtCellDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('fr-FR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export function YearHeatmap({ year, data, highlightRange, defaultMonth }: YearHeatmapProps) {
  const { palette } = useTheme();
  const styles = useMemo(() => makeStyles(palette), [palette]);
  const scrollRef = useRef<ScrollView>(null);
  const rootRef = useRef<View>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);

  const byDate = useMemo(() => {
    const m = new Map<string, DailyPoint>();
    for (const pt of data) m.set(pt.date, pt);
    return m;
  }, [data]);

  const { cells, monthLabels, columns } = useMemo(() => {
    const jan1 = new Date(year, 0, 1);
    const dec31 = new Date(year, 11, 31);
    const firstDow = mondayFirstDow(jan1);
    const totalDays = Math.round((dec31.getTime() - jan1.getTime()) / 86_400_000) + 1;
    const cols = Math.ceil((totalDays + firstDow) / 7);

    const out: Cell[] = [];
    const labels: { col: number; label: string }[] = [];
    let lastLabeledCol = -3;

    for (let i = 0; i < totalDays; i++) {
      const d = new Date(year, 0, 1 + i);
      const idx = i + firstDow;
      const col = Math.floor(idx / 7);
      const row = idx % 7;
      const iso = isoOf(d);
      const pt = byDate.get(iso);
      out.push({ date: iso, col, row, amount: pt?.amount ?? 0, salesCount: pt?.sales_count ?? 0 });

      if (d.getDate() === 1 && col > lastLabeledCol + 1) {
        labels.push({ col, label: MONTH_LABELS_FR[d.getMonth()] });
        lastLabeledCol = col;
      }
    }
    return { cells: out, monthLabels: labels, columns: cols };
  }, [year, byDate]);

  const maxAmount = Math.max(...cells.map(c => c.amount), 1);

  const colorFor = (amount: number, date: string) => {
    const inRange = !highlightRange || (date >= highlightRange.start && date <= highlightRange.end);
    if (!inRange) return palette.border;
    if (amount <= 0) return palette.border;
    const ratio = amount / maxAmount;
    return ratio > 0.5 ? `${palette.success}FF` : `${palette.success}4D`;
  };

  const gridWidth = columns * STEP;
  const gridHeight = ROWS * STEP + MONTH_ROW_HEIGHT;

  // scrollToEnd() is unreliable here because it scrolls to the ScrollView's
  // own JS-tracked contentSize state, which is itself only populated by an
  // onContentSizeChange event — on first mount (right after a route
  // transition into this screen) that event can fire before the native
  // scroll view has actually finished laying out, so scrollToEnd computes
  // its target off a stale/zero size and silently no-ops. scrollTo({x:
  // gridWidth}) sidesteps that bookkeeping entirely: gridWidth is computed
  // synchronously from `columns` (known up front, no native round-trip
  // needed), is always >= the true max scroll offset, and RN's native
  // scroll view clamps an out-of-range x to its real content edge — so it
  // reliably lands at the end regardless of whether onContentSizeChange
  // has fired yet. Deferred via InteractionManager (same pattern already
  // used for the post-navigation biometric prompt) so it runs after the
  // screen's own route transition settles, not mid-animation.
  const scrollToPosition = () => {
    let scrollX = gridWidth;
    if (defaultMonth !== undefined && defaultMonth > 0 && defaultMonth <= 12) {
      const targetLabel = MONTH_LABELS_FR[defaultMonth - 1];
      const targetMonth = monthLabels.find(m => m.label === targetLabel);
      if (targetMonth) {
        scrollX = Math.max(0, targetMonth.col * STEP - 60);
      }
    }
    scrollRef.current?.scrollTo({ x: scrollX, animated: false });
  };

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(scrollToPosition);
    return () => task.cancel();
  }, [gridWidth, monthLabels, defaultMonth, year]);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  const dismissTooltip = () => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    setTooltip(null);
  };

  const handleCellPress = (cell: Cell, pageX: number, pageY: number) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (tooltip?.cell.date === cell.date) { setTooltip(null); return; }
    rootRef.current?.measure((_x, _y, containerW, _h, rootPageX, rootPageY) => {
      const localX = pageX - rootPageX;
      const localY = pageY - rootPageY;
      const left = Math.min(Math.max(localX - TOOLTIP_W / 2, 4), Math.max(4, containerW - TOOLTIP_W - 4));
      const top = Math.max(localY - 58, 0);
      setTooltip({ cell, left, top });
      hideTimer.current = setTimeout(() => setTooltip(null), TOOLTIP_AUTO_HIDE_MS);
    });
  };

  return (
    <View ref={rootRef} style={styles.root} collapsable={false}>
      <View style={styles.row}>
        <View style={[styles.dowCol, { marginTop: MONTH_ROW_HEIGHT }]}>
          {Array.from({ length: ROWS }, (_, r) => (
            <View key={r} style={{ height: STEP, justifyContent: 'center' }}>
              {ROW_LABELS[r] ? <Text style={styles.dowLabel}>{ROW_LABELS[r]}</Text> : null}
            </View>
          ))}
        </View>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ height: gridHeight }}
          onContentSizeChange={scrollToPosition}
        >
          <Svg width={gridWidth} height={gridHeight}>
            {monthLabels.map(m => (
              <SvgText key={m.col} x={m.col * STEP} y={MONTH_ROW_HEIGHT - 5} fontSize={10} fill={palette.textSecondary}>
                {m.label}
              </SvgText>
            ))}
            {cells.map(c => (
              <Rect
                key={c.date}
                x={c.col * STEP}
                y={MONTH_ROW_HEIGHT + c.row * STEP}
                width={CELL}
                height={CELL}
                rx={2.5}
                fill={colorFor(c.amount, c.date)}
                onPress={(e: GestureResponderEvent) => handleCellPress(c, e.nativeEvent.pageX, e.nativeEvent.pageY)}
              />
            ))}
          </Svg>
        </ScrollView>
      </View>

      {tooltip && (
        <>
          <Pressable style={StyleSheet.absoluteFill} onPress={dismissTooltip} />
          <View style={[styles.tooltip, { left: tooltip.left, top: tooltip.top }]} pointerEvents="none">
            <Text style={styles.tooltipCount}>
              {tooltip.cell.salesCount > 0
                ? `${tooltip.cell.salesCount} vente${tooltip.cell.salesCount > 1 ? 's' : ''}`
                : 'Aucune vente'}
            </Text>
            <Text style={styles.tooltipDate}>{fmtCellDate(tooltip.cell.date)}</Text>
          </View>
        </>
      )}
    </View>
  );
}

function makeStyles(p: Palette) {
  return StyleSheet.create({
    root:         { position: 'relative' as const },
    row:          { flexDirection: 'row', gap: spacing[2] },
    dowCol:       { width: 24 },
    dowLabel:     { fontSize: 9, lineHeight: STEP, color: p.textSecondary },
    tooltip: {
      position: 'absolute' as const,
      width: TOOLTIP_W,
      backgroundColor: p.surfaceElevated,
      borderWidth: 1,
      borderColor: p.border,
      borderRadius: radius.md,
      paddingVertical: spacing[2],
      paddingHorizontal: spacing[3],
      gap: 2,
      ...shadow.md,
    },
    tooltipCount: { fontSize: 13, fontWeight: '700' as const, color: p.textPrimary },
    tooltipDate:  { fontSize: 11, color: p.textSecondary, textTransform: 'capitalize' as const },
  });
}
