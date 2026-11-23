"""
Tek otomatik ders dağıtım motoru: Google OR-Tools CP-SAT (solver_ortools.py).
Yalnızca Google OR-Tools CP-SAT kullanır; hiçbir yedek/greedy/JS çözücü içermez.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

import ortools
from ortools.sat.python import cp_model

# PyInstaller onedir/onefile ve doğrudan çalıştırmada yerel modül yolunu garantiye al
_CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
if _CURRENT_DIR not in sys.path:
    sys.path.insert(0, _CURRENT_DIR)

from validate_model import (  # noqa: E402
    build_time_intervals,
    compute_valid_starts_for_block,
    extract_grid_sets,
    get_block_physical_span,
    get_teacher_prefer_avoid_set,
    get_teacher_unavailable_set,
    resolve_fixed_assignments,
    validate_model,
)
from validate_result import validate_result  # noqa: E402

ENGINE_NAME = "google_ortools_cp_sat"

PREFERENCE_WEIGHTS = {
    "balanced": {"gap": 10, "avoid": 6, "spread": 8, "balance": 4},
    "fewer_gaps": {"gap": 24, "avoid": 6, "spread": 4, "balance": 2},
    "spread_days": {"gap": 6, "avoid": 6, "spread": 20, "balance": 8},
}


def emit_progress(phase: str, message: str) -> None:
    try:
        payload = json.dumps({"type": "progress", "phase": phase, "message": message}, ensure_ascii=False)
        sys.stderr.write(payload + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def assign_pool_rooms(
    placements: List[Dict[str, Any]],
    assignments_by_id: Dict[str, Dict[str, Any]],
    rooms_by_type: Dict[str, List[Dict[str, Any]]],
    classes_map: Dict[str, Dict[str, Any]],
    intervals: Dict[str, List[Tuple[int, int]]],
) -> None:
    """
    room_id atanmamış ancak özel room_type isteyen derslere,
    aynı türdeki derslik havuzundan çakışmasız somut room_id atar.
    """
    by_type_day: Dict[Tuple[str, int], List[Tuple[int, int, Dict[str, Any]]]] = defaultdict(list)
    for pl in placements:
        if pl.get("room_id"):
            continue
        asgn = assignments_by_id[pl["assignment_id"]]
        rtype = asgn.get("room_type") or "standard"
        if rtype == "standard" or not rooms_by_type.get(rtype):
            continue
        shift = classes_map[pl["class_id"]].get("shift") or "full_day"
        s, e = get_block_physical_span(intervals, shift, pl["start_period"], pl["length"])
        by_type_day[(rtype, pl["day_index"])].append((s, e, pl))

    for (rtype, _day), items in by_type_day.items():
        pool = rooms_by_type[rtype]
        # Her oda kapasitesi kadar birim slot aç
        slots: List[Tuple[str, int]] = []  # (room_id, free_after_min)
        for rm in pool:
            cap = int(rm.get("simultaneous_capacity") or 1)
            for _ in range(cap):
                slots.append((rm["id"], -1))

        items.sort(key=lambda x: (x[0], x[1]))
        for s, e, pl in items:
            assigned = None
            for idx, (rid, free_at) in enumerate(slots):
                if free_at <= s:
                    slots[idx] = (rid, e)
                    assigned = rid
                    break
            if assigned:
                pl["room_id"] = assigned


def solve_timetable(config: Dict[str, Any]) -> Dict[str, Any]:
    t0 = time.perf_counter()
    emit_progress("validating", "Model kontrol ediliyor")

    validation = validate_model(config)
    total_blocks = int((validation.get("summary") or {}).get("total_blocks") or 0)
    if total_blocks == 0:
        for asgn in config.get("assignments") or []:
            total_blocks += len(asgn.get("blocks") or [])

    if not validation["valid"]:
        unplaced = []
        for asgn in config.get("assignments") or []:
            for b_idx, blen in enumerate(asgn.get("blocks") or []):
                unplaced.append({
                    "assignment_id": asgn.get("assignment_id"),
                    "block_index": b_idx,
                    "class_id": asgn.get("class_id"),
                    "class_name": asgn.get("class_name"),
                    "course_id": asgn.get("course_id"),
                    "course_code": asgn.get("course_code"),
                    "course_name": asgn.get("course_name"),
                    "teacher_ids": asgn.get("teacher_ids") or [],
                    "room_id": asgn.get("room_id"),
                    "length": int(blen),
                })
        return {
            "engine": ENGINE_NAME,
            "status": "INFEASIBLE",
            "solve_time_sec": round(time.perf_counter() - t0, 3),
            "placed_blocks": 0,
            "total_blocks": total_blocks,
            "placements": [],
            "unplaced": unplaced,
            "diagnostics": validation["errors"],
            "message": validation["errors"][0]["message"] if validation["errors"] else "Model ön denetimden geçemedi.",
        }

    time_grid = config.get("time_grid") or {}
    num_days, periods_per_day, blocked, common_elective, lunch_after, long_break_after = extract_grid_sets(time_grid)
    intervals = build_time_intervals(time_grid)

    classes = config.get("classes") or []
    teachers = config.get("teachers") or []
    rooms = config.get("rooms") or []
    assignments = config.get("assignments") or []

    class_map = {c["id"]: c for c in classes}
    teacher_map = {t["id"]: t for t in teachers}
    room_map = {r["id"]: r for r in rooms}
    rooms_by_type: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for r in rooms:
        rooms_by_type[r.get("room_type") or "standard"].append(r)
    assignments_by_id = {a["assignment_id"]: a for a in assignments}

    has_common_elective_courses = any(bool(a.get("use_common_elective_slot")) for a in assignments)
    enforce_common_exclusivity = bool(common_elective) and has_common_elective_courses

    teacher_unavail = {tid: get_teacher_unavailable_set(t, num_days, periods_per_day) for tid, t in teacher_map.items()}
    teacher_avoid = {tid: get_teacher_prefer_avoid_set(t, num_days, periods_per_day) for tid, t in teacher_map.items()}

    resolved_fixed, _ = resolve_fixed_assignments(config.get("fixed_assignments") or [], assignments_by_id)

    sol_req = config.get("solution_request") or {}
    solver_cfg = config.get("solver_config") or {}
    pref_key = sol_req.get("preference") or solver_cfg.get("preference") or "balanced"
    if pref_key not in PREFERENCE_WEIGHTS:
        pref_key = "balanced"
    weights = PREFERENCE_WEIGHTS[pref_key]

    max_time_sec = float(
        solver_cfg.get("max_time_seconds")
        or solver_cfg.get("timeLimitSec")
        or 60
    )
    max_time_sec = max(1.0, min(600.0, max_time_sec))

    # =========================================================================
    # CP-SAT MODEL KURULUMU
    # =========================================================================
    emit_progress("solving", "OR-Tools çözüm arıyor")
    model = cp_model.CpModel()

    # x[(aid, b_idx, d, p)] -> BoolVar
    x: Dict[Tuple[str, int, int, int], cp_model.IntVar] = {}
    block_candidates: Dict[Tuple[str, int], List[Tuple[int, int, cp_model.IntVar]]] = {}
    block_meta: Dict[Tuple[str, int], Dict[str, Any]] = {}

    # Fiziksel zaman çakışma indeksleri: (entity_id, day) -> [(start_min, end_min, var, length)]
    class_day_vars: Dict[Tuple[str, int], List[Tuple[int, int, cp_model.IntVar, int]]] = defaultdict(list)
    teacher_day_vars: Dict[Tuple[str, int], List[Tuple[int, int, cp_model.IntVar, int]]] = defaultdict(list)
    teacher_day_period_vars: Dict[Tuple[str, int, int], List[cp_model.IntVar]] = defaultdict(list)
    room_day_vars: Dict[Tuple[str, int], List[Tuple[int, int, cp_model.IntVar, int]]] = defaultdict(list)
    room_type_day_vars: Dict[Tuple[str, int], List[Tuple[int, int, cp_model.IntVar, int]]] = defaultdict(list)
    asgn_day_vars: Dict[Tuple[str, int], List[cp_model.IntVar]] = defaultdict(list)
    teacher_building_day_vars: Dict[Tuple[str, int], List[Tuple[int, int, str, cp_model.IntVar]]] = defaultdict(list)
    class_common_slot_vars: Dict[Tuple[str, int, int], List[cp_model.IntVar]] = defaultdict(list)
    class_common_hours: Dict[str, int] = defaultdict(int)

    school_cfg = config.get("school") or {}
    travel_min = int(school_cfg.get("building_travel_minutes") or 0)

    objective_terms: List[cp_model.LinearExpr] = []

    for asgn in assignments:
        aid = asgn["assignment_id"]
        cid = asgn["class_id"]
        cls = class_map[cid]
        cls_shift = cls.get("shift") or "full_day"
        t_ids = list(asgn.get("teacher_ids") or [])
        base_room_id = asgn.get("room_id")
        room_type = asgn.get("room_type") or "standard"
        use_common = bool(asgn.get("use_common_elective_slot"))
        t_unavails = [teacher_unavail[tid] for tid in t_ids]
        blocks = [int(b) for b in (asgn.get("blocks") or [])]
        if use_common:
            class_common_hours[cid] += sum(blocks)

        for b_idx, blen in enumerate(blocks):
            key = (aid, b_idx)
            fa_entry = resolved_fixed.get(key)
            eff_room_id = (fa_entry.get("room_id") if fa_entry and fa_entry.get("room_id") else base_room_id)
            block_meta[key] = {
                "assignment": asgn,
                "length": blen,
                "shift": cls_shift,
                "room_id": eff_room_id,
            }

            if fa_entry is not None:
                valid_starts = [(fa_entry["day_index"], fa_entry["start_period"])]
            else:
                _, valid_starts = compute_valid_starts_for_block(
                    length=blen,
                    num_days=num_days,
                    periods_per_day=periods_per_day,
                    blocked=blocked,
                    common_elective=common_elective,
                    use_common_elective=use_common,
                    enforce_common_elective_exclusivity=enforce_common_exclusivity,
                    lunch_after=lunch_after,
                    long_break_after=long_break_after,
                    class_shift=cls_shift,
                    teacher_unavail_sets=t_unavails,
                )

            # Kesin kural: hiç uygun aday yoksa sessiz atlama YOK -> INFEASIBLE
            if not valid_starts:
                return {
                    "engine": ENGINE_NAME,
                    "status": "INFEASIBLE",
                    "solve_time_sec": round(time.perf_counter() - t0, 3),
                    "placed_blocks": 0,
                    "total_blocks": total_blocks,
                    "placements": [],
                    "unplaced": [],
                    "diagnostics": [{
                        "code": "NO_VALID_START",
                        "message": f"{asgn.get('class_name')} {asgn.get('course_name')} dersi için {blen} saatlik blok yerleştirilemiyor. Uygun açık ders saati bulunmuyor.",
                    }],
                    "message": f"{asgn.get('class_name')} - {asgn.get('course_name')} dersi için uygun zaman bulunamadı.",
                }

            blk_building = None
            if eff_room_id and eff_room_id in room_map and room_map[eff_room_id].get("building"):
                blk_building = str(room_map[eff_room_id]["building"]).strip()
            elif cls.get("building"):
                blk_building = str(cls["building"]).strip()

            cands: List[Tuple[int, int, cp_model.IntVar]] = []
            for d, p in valid_starts:
                var = model.NewBoolVar(f"x_{aid}_{b_idx}_{d}_{p}")
                x[(aid, b_idx, d, p)] = var
                cands.append((d, p, var))

                span_s, span_e = get_block_physical_span(intervals, cls_shift, p, blen)
                class_day_vars[(cid, d)].append((span_s, span_e, var, blen))
                asgn_day_vars[(aid, d)].append(var)

                if use_common:
                    for k in range(blen):
                        class_common_slot_vars[(cid, d, p + k)].append(var)

                for tid in t_ids:
                    teacher_day_vars[(tid, d)].append((span_s, span_e, var, blen))
                    if travel_min > 0 and blk_building:
                        teacher_building_day_vars[(tid, d)].append((span_s, span_e, blk_building, var))
                    for k in range(blen):
                        teacher_day_period_vars[(tid, d, p + k)].append(var)
                        if (d, p + k) in teacher_avoid[tid]:
                            objective_terms.append(weights["avoid"] * var)

                if eff_room_id:
                    room_day_vars[(eff_room_id, d)].append((span_s, span_e, var, blen))
                elif room_type != "standard" and rooms_by_type.get(room_type):
                    room_type_day_vars[(room_type, d)].append((span_s, span_e, var, blen))

            block_candidates[key] = cands
            # Kural 1: Her blok tam bir kez yerleşir
            model.AddExactlyOne([v for _, _, v in cands])

        # Aynı uzunlukta ve sabitlenmemiş ardışık bloklar arasında simetri kırma
        if len(blocks) > 1:
            for b_idx in range(len(blocks) - 1):
                k1 = (aid, b_idx)
                k2 = (aid, b_idx + 1)
                if blocks[b_idx] == blocks[b_idx + 1] and k1 not in resolved_fixed and k2 not in resolved_fixed:
                    pos1 = sum((d * periods_per_day + p) * v for d, p, v in block_candidates[k1])
                    pos2 = sum((d * periods_per_day + p) * v for d, p, v in block_candidates[k2])
                    model.Add(pos1 < pos2)

    # Kural 2: Şube çakışması yok (fiziksel zaman aralıkları)
    for (_cid, _d), items in class_day_vars.items():
        start_points = sorted({s for s, _, _, _ in items})
        for t_pt in start_points:
            covering = [v for s, e, v, _ in items if s <= t_pt < e]
            if len(covering) > 1:
                model.AddAtMostOne(covering)

    # Kural 3: Öğretmen çakışması yok (fiziksel zaman aralıkları — ikili öğretim dahil)
    for (_tid, _d), items in teacher_day_vars.items():
        start_points = sorted({s for s, _, _, _ in items})
        for t_pt in start_points:
            covering = [v for s, e, v, _ in items if s <= t_pt < e]
            if len(covering) > 1:
                model.AddAtMostOne(covering)

    # Kural 5: Özel derslik kapasitesi (açıkça seçilmiş room_id)
    for (rid, _d), items in room_day_vars.items():
        cap = int(room_map[rid].get("simultaneous_capacity") or 1)
        start_points = sorted({s for s, _, _, _ in items})
        for t_pt in start_points:
            covering = [v for s, e, v, _ in items if s <= t_pt < e]
            if len(covering) > cap:
                if cap == 1:
                    model.AddAtMostOne(covering)
                else:
                    model.Add(sum(covering) <= cap)

    # Kural 5b: Özel derslik türü havuzu kapasitesi
    for (rtype, _d), items in room_type_day_vars.items():
        pool = rooms_by_type.get(rtype) or []
        total_cap = sum(int(r.get("simultaneous_capacity") or 1) for r in pool)
        start_points = sorted({s for s, _, _, _ in items})
        for t_pt in start_points:
            covering = [v for s, e, v, _ in items if s <= t_pt < e]
            if len(covering) > total_cap:
                if total_cap == 1:
                    model.AddAtMostOne(covering)
                else:
                    model.Add(sum(covering) <= total_cap)

    # Kural 8a: Aynı dersin günlük blok sayısı sınırı + günlere yayma hedefi
    for asgn in assignments:
        aid = asgn["assignment_id"]
        max_per_day = int(asgn.get("max_blocks_per_day") or 1)
        day_active_vars: List[cp_model.IntVar] = []
        for d in range(num_days):
            d_vars = asgn_day_vars.get((aid, d)) or []
            if not d_vars:
                day_active_vars.append(model.NewConstant(0))
                continue
            if max_per_day > 0:
                if max_per_day == 1 and len(d_vars) > 1:
                    model.AddAtMostOne(d_vars)
                elif len(d_vars) > max_per_day:
                    model.Add(sum(d_vars) <= max_per_day)

            # Günlere yayma yumuşak cezası: aynı gün 1'den fazla blok veya ardışık günler
            if max_per_day > 1 and len(d_vars) > 1 and weights["spread"] > 0:
                extra = model.NewIntVar(0, max_per_day, f"extra_{aid}_{d}")
                model.Add(extra >= sum(d_vars) - 1)
                objective_terms.append(weights["spread"] * extra)

            if len(asgn.get("blocks") or []) > 1 and len(asgn.get("blocks") or []) <= (num_days + 1) // 2:
                has_day = model.NewBoolVar(f"ad_{aid}_{d}")
                model.AddMaxEquality(has_day, d_vars)
                day_active_vars.append(has_day)
            else:
                day_active_vars.append(model.NewConstant(0))

        # Az bloklu derslerin arka arkaya günlere yığılmasını hafifçe cezalandır
        if len(asgn.get("blocks") or []) > 1 and len(asgn.get("blocks") or []) <= (num_days + 1) // 2 and weights["spread"] > 0:
            for d in range(num_days - 1):
                adj = model.NewBoolVar(f"adj_{aid}_{d}")
                model.Add(adj >= day_active_vars[d] + day_active_vars[d + 1] - 1)
                objective_terms.append((weights["spread"] // 2) * adj)

    # Kural 8b & 11: Öğretmen günlük maks saat, ardışık maks saat, boş pencere, çalışılabilir gün ve denge hedefleri
    is_double_shift = isinstance(time_grid.get("bell_schedule"), dict)
    for tid, t in teacher_map.items():
        max_daily = int(t.get("max_daily_hours") or periods_per_day)
        max_consec = int(t.get("max_consecutive_hours") or 0)
        max_gaps_day = int(t.get("max_daily_gaps") or 0)
        max_work_days = int(t.get("max_working_days") or 0)

        day_loads: List[cp_model.LinearExpr] = []
        working_day_vars: List[cp_model.IntVar] = []
        has_any_var = False

        for d in range(num_days):
            items = teacher_day_vars.get((tid, d)) or []
            if not items:
                continue
            has_any_var = True
            day_load = sum(blen * v for _, _, v, blen in items)
            model.Add(day_load <= max_daily)
            day_loads.append(day_load)

            if 0 < max_work_days < num_days:
                wd = model.NewBoolVar(f"wd_{tid}_{d}")
                model.AddMaxEquality(wd, [v for _, _, v, _ in items])
                working_day_vars.append(wd)

            # Bina geçiş süresi kısıtı (farklı binalardaki iki ders arasında en az travel_min dk boşluk)
            if travel_min > 0:
                b_items = teacher_building_day_vars.get((tid, d)) or []
                if len(b_items) >= 2:
                    by_bspan: Dict[Tuple[str, int, int], List[cp_model.IntVar]] = defaultdict(list)
                    for bs, be, bname, bv in b_items:
                        by_bspan[(bname, bs, be)].append(bv)
                    grouped = list(by_bspan.items())
                    for i in range(len(grouped)):
                        (b1, s1, e1), vars1 = grouped[i]
                        for j in range(i + 1, len(grouped)):
                            (b2, s2, e2), vars2 = grouped[j]
                            if b1 == b2:
                                continue
                            # İki farklı binadaki derslerin arası travel_min'den azsa birlikte seçilemez
                            if (s2 - e1) < travel_min and (s1 - e2) < travel_min:
                                model.Add(sum(vars1) + sum(vars2) <= 1)

            # Boş pencere (gap) ve ardışık ders sınırı (tekli öğretimde doğrudan periyot dizisi üzerinde)
            if not is_double_shift and periods_per_day >= 3:
                busy_vars: List[cp_model.IntVar] = []
                for p in range(periods_per_day):
                    p_vars = teacher_day_period_vars.get((tid, d, p)) or []
                    if not p_vars:
                        busy_vars.append(model.NewConstant(0))
                    elif len(p_vars) == 1:
                        busy_vars.append(p_vars[0])
                    else:
                        bv = model.NewBoolVar(f"tb_{tid}_{d}_{p}")
                        model.Add(bv == sum(p_vars))
                        busy_vars.append(bv)

                # Ardışık maksimum ders saati (isteğe bağlı sert kural)
                if max_consec > 0 and max_consec < periods_per_day:
                    for p in range(periods_per_day - max_consec):
                        model.Add(sum(busy_vars[p : p + max_consec + 1]) <= max_consec)

                # O(P) doğrusal boş pencere (gap) hesaplaması
                if weights["gap"] > 0 or max_gaps_day > 0:
                    has_before = [model.NewConstant(0)]
                    for p in range(1, periods_per_day):
                        hb = model.NewBoolVar(f"hb_{tid}_{d}_{p}")
                        model.Add(hb >= busy_vars[p - 1])
                        model.Add(hb >= has_before[p - 1])
                        has_before.append(hb)

                    has_after: List[cp_model.IntVar] = [model.NewConstant(0)] * periods_per_day
                    for p in range(periods_per_day - 2, -1, -1):
                        ha = model.NewBoolVar(f"ha_{tid}_{d}_{p}")
                        model.Add(ha >= busy_vars[p + 1])
                        model.Add(ha >= has_after[p + 1])
                        has_after[p] = ha

                    day_gaps: List[cp_model.IntVar] = []
                    for p in range(1, periods_per_day - 1):
                        gp = model.NewBoolVar(f"gp_{tid}_{d}_{p}")
                        model.Add(gp >= has_before[p] + has_after[p] - busy_vars[p] - 1)
                        day_gaps.append(gp)
                        if weights["gap"] > 0:
                            objective_terms.append(weights["gap"] * gp)

                    if max_gaps_day > 0 and day_gaps:
                        model.Add(sum(day_gaps) <= max_gaps_day)

        if 0 < max_work_days < num_days and len(working_day_vars) > max_work_days:
            model.Add(sum(working_day_vars) <= max_work_days)

        if has_any_var and len(day_loads) > 1 and weights["balance"] > 0:
            max_day_load = model.NewIntVar(0, max_daily, f"mdl_{tid}")
            for dl in day_loads:
                model.Add(max_day_load >= dl)
            objective_terms.append(weights["balance"] * max_day_load)

    # Kural 9b: Aynı sınıf düzeyinde ortak seçmeli dersi olan şubelerin ortak seçmeli saatlerini senkronize et
    if common_elective and class_common_hours:
        by_grade_hrs: Dict[Tuple[str, int], List[str]] = defaultdict(list)
        for cid, chrs in class_common_hours.items():
            if chrs > 0 and cid in class_map:
                gkey = str(class_map[cid].get("grade_key") or "")
                by_grade_hrs[(gkey, chrs)].append(cid)
        for (_gkey, _chrs), cids in by_grade_hrs.items():
            if len(cids) < 2:
                continue
            ref_cid = cids[0]
            for other_cid in cids[1:]:
                for d, p in sorted(common_elective):
                    ref_vars = class_common_slot_vars.get((ref_cid, d, p)) or []
                    oth_vars = class_common_slot_vars.get((other_cid, d, p)) or []
                    if ref_vars or oth_vars:
                        model.Add(sum(ref_vars) == sum(oth_vars))

    # Kural 12 (Aşama 3): En Az Değişiklikle Onarma (repair_min_changes)
    req_mode = str(sol_req.get("mode") or "full_solve")
    prev_placements_raw = (
        config.get("previous_placements")
        or sol_req.get("previous_placements")
        or []
    )
    prev_map: Dict[Tuple[str, int], Tuple[int, int]] = {}
    if prev_placements_raw:
        resolved_prev, _ = resolve_fixed_assignments(prev_placements_raw, assignments_by_id)
        for pkey, pinfo in resolved_prev.items():
            prev_map[pkey] = (pinfo["day_index"], pinfo["start_period"])

    if req_mode == "repair_min_changes" and prev_map:
        CHANGE_BLOCK_PENALTY = 1000
        CHANGE_ENTITY_PENALTY = 300
        teacher_moved_vars: Dict[str, List[cp_model.IntVar]] = defaultdict(list)
        class_moved_vars: Dict[str, List[cp_model.IntVar]] = defaultdict(list)

        for key, (prev_d, prev_p) in prev_map.items():
            if key in resolved_fixed or key not in block_candidates:
                continue
            aid, b_idx = key
            asgn = assignments_by_id[aid]
            stay_var = x.get((aid, b_idx, prev_d, prev_p))
            if stay_var is not None:
                moved = model.NewBoolVar(f"mv_{aid}_{b_idx}")
                model.Add(moved + stay_var == 1)
                model.AddHint(stay_var, 1)
                objective_terms.append(CHANGE_BLOCK_PENALTY * moved)
                class_moved_vars[asgn["class_id"]].append(moved)
                for tid in asgn.get("teacher_ids") or []:
                    teacher_moved_vars[tid].append(moved)

        for cid_k, mvars in class_moved_vars.items():
            if not mvars:
                continue
            cls_changed = model.NewBoolVar(f"cchg_{cid_k}")
            model.AddMaxEquality(cls_changed, mvars)
            objective_terms.append(CHANGE_ENTITY_PENALTY * cls_changed)

        for tid_k, mvars in teacher_moved_vars.items():
            if not mvars:
                continue
            tch_changed = model.NewBoolVar(f"tchg_{tid_k}")
            model.AddMaxEquality(tch_changed, mvars)
            objective_terms.append(CHANGE_ENTITY_PENALTY * tch_changed)

    if objective_terms:
        model.Minimize(sum(objective_terms))

    # =========================================================================
    # CP-SAT ÇÖZÜM
    # =========================================================================
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = max_time_sec
    num_workers = int(solver_cfg.get("numWorkers") or min(8, os.cpu_count() or 4))
    solver.parameters.num_search_workers = max(1, min(16, num_workers))
    if req_mode not in ("regenerate", "full_solve_fresh"):
        solver.parameters.random_seed = 42

    status_code = solver.Solve(model)
    status_name = solver.StatusName(status_code)
    solve_time = round(time.perf_counter() - t0, 3)

    if status_code not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        diag_msg = (
            "Kısıtlar birbiriyle çelişiyor; öğretmen kapalı saatleri, günlük sınırlar, özel mekanlar veya sabit dersleri kontrol edin."
            if status_name == "INFEASIBLE"
            else (
                f"Belirlenen sürede ({int(max_time_sec)} sn) geçerli bir çözüm bulunamadı."
                if status_name == "UNKNOWN"
                else "Model kurulumunda geçersiz bir durum oluştu."
            )
        )
        return {
            "engine": ENGINE_NAME,
            "status": status_name,
            "solve_time_sec": solve_time,
            "placed_blocks": 0,
            "total_blocks": total_blocks,
            "placements": [],
            "unplaced": [],
            "diagnostics": [{"code": status_name, "message": diag_msg}],
            "message": diag_msg,
        }

    # =========================================================================
    # SONUÇ ÇIKARIMI VE BAĞIMSIZ DOĞRULAMA
    # =========================================================================
    emit_progress("verifying", "Doğrulanıyor")
    placements: List[Dict[str, Any]] = []
    for (aid, b_idx), cands in block_candidates.items():
        asgn = assignments_by_id[aid]
        blen = block_meta[(aid, b_idx)]["length"]
        for d, p, var in cands:
            if solver.BooleanValue(var):
                placements.append({
                    "block_id": f"{aid}__b{b_idx}",
                    "assignment_id": aid,
                    "block_index": b_idx,
                    "class_id": asgn["class_id"],
                    "class_name": asgn.get("class_name", ""),
                    "course_id": asgn["course_id"],
                    "course_code": asgn.get("course_code", ""),
                    "course_name": asgn.get("course_name", ""),
                    "teacher_ids": list(asgn.get("teacher_ids") or []),
                    "room_id": block_meta[(aid, b_idx)].get("room_id") or None,
                    "day_index": d,
                    "start_period": p,
                    "length": blen,
                })
                break

    # Özel derslik türü havuzu olan derslere çakışmasız somut room_id ata
    assign_pool_rooms(placements, assignments_by_id, rooms_by_type, class_map, intervals)

    placements.sort(key=lambda item: (item["class_id"], item["day_index"], item["start_period"], item["block_index"]))

    result = {
        "engine": ENGINE_NAME,
        "status": status_name,
        "solve_time_sec": round(time.perf_counter() - t0, 3),
        "placed_blocks": len(placements),
        "total_blocks": total_blocks,
        "placements": placements,
        "unplaced": [],
        "diagnostics": [],
        "message": f"OR-Tools CP-SAT dağıtımı tamamlandı ({len(placements)}/{total_blocks} blok).",
    }

    verification = validate_result(config, result)
    if not verification["valid"]:
        return {
            "engine": ENGINE_NAME,
            "status": "MODEL_INVALID",
            "solve_time_sec": round(time.perf_counter() - t0, 3),
            "placed_blocks": 0,
            "total_blocks": total_blocks,
            "placements": [],
            "unplaced": [],
            "diagnostics": verification["errors"],
            "message": "Çözüm doğrulama testinden geçemedi; hatalı program yüklenmedi.",
        }

    emit_progress("done", "Tamamlandı")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Okul Ders Dağıtım Programı — Google OR-Tools CP-SAT Motoru")
    parser.add_argument("--input", help="Girdi model JSON dosya yolu")
    parser.add_argument("--output", help="Çıktı çözüm JSON dosya yolu")
    parser.add_argument("--info", action="store_true", help="Motor ve sürüm bilgisi döndür")
    parser.add_argument("--validate", action="store_true", help="Mevcut çözümü bağımsız doğrula")
    args = parser.parse_args()

    if args.info:
        info = {
            "engine": ENGINE_NAME,
            "ortools_version": getattr(ortools, "__version__", "unknown"),
            "python_version": sys.version.split()[0],
        }
        sys.stdout.write(json.dumps(info, ensure_ascii=False))
        sys.stdout.flush()
        return 0

    if args.validate:
        try:
            if args.input:
                with open(args.input, "r", encoding="utf-8") as f:
                    payload = json.load(f)
            else:
                payload = json.loads(sys.stdin.read())
            cfg_in = payload.get("config") or {}
            sol_in = payload.get("solution") or {}
            model_check = validate_model(cfg_in)
            res_check = validate_result(cfg_in, sol_in)
            out_obj = {
                "valid": bool(model_check["valid"] and res_check["valid"]),
                "model_errors": model_check["errors"],
                "result_errors": res_check["errors"],
                "stats": res_check.get("stats") or {},
            }
            out_str = json.dumps(out_obj, ensure_ascii=False)
            if args.output:
                with open(args.output, "w", encoding="utf-8") as f:
                    f.write(out_str)
            else:
                sys.stdout.write(out_str)
                sys.stdout.flush()
            return 0
        except Exception as exc:
            err_str = json.dumps({"valid": False, "model_errors": [], "result_errors": [{"code": "VALIDATE_ERROR", "message": str(exc)}]}, ensure_ascii=False)
            if args.output:
                with open(args.output, "w", encoding="utf-8") as f:
                    f.write(err_str)
            else:
                sys.stdout.write(err_str)
            return 1

    try:
        if args.input:
            with open(args.input, "r", encoding="utf-8") as f:
                config = json.load(f)
        else:
            raw = sys.stdin.read()
            config = json.loads(raw)
    except Exception as exc:
        err_result = {
            "engine": ENGINE_NAME,
            "status": "MODEL_INVALID",
            "solve_time_sec": 0.0,
            "placed_blocks": 0,
            "total_blocks": 0,
            "placements": [],
            "unplaced": [],
            "diagnostics": [{"code": "JSON_READ_ERROR", "message": f"Girdi JSON okunamadı: {exc}"}],
            "message": f"Girdi JSON okunamadı: {exc}",
        }
        out_str = json.dumps(err_result, ensure_ascii=False)
        if args.output:
            with open(args.output, "w", encoding="utf-8") as f:
                f.write(out_str)
        else:
            sys.stdout.write(out_str)
        return 1

    result = solve_timetable(config)
    out_str = json.dumps(result, ensure_ascii=False)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out_str)
    else:
        sys.stdout.write(out_str)
        sys.stdout.flush()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
