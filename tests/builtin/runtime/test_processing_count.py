"""Count admission must reach later pages and revisit unchanged dirty intents."""

from __future__ import annotations

import asyncio

from powercontext.builtin.runtime.artifact_processing import ArtifactProcessingBinding, ArtifactProcessingSupervisor
from tests.builtin.runtime.test_processing_scheduler import _Launcher, _profile, _request, _wait


def test_count_discovery_reaches_later_scopes_and_rechecks_without_a_wake(tmp_path):
    async def scenario():
        async with _profile(tmp_path, "count-pagination") as profile:
            # More dirty scopes than the resident queue can accommodate. None
            # of the first pages is eligible, so a single-page scan would stall.
            scopes = tuple(f"scope-{number:03}" for number in range(40))
            for scope in scopes:
                await _request(profile.database, "memory-binding", scope, requested=False)
            eligible = {scopes[-1]}

            async def count_filter(connection, candidates):
                return frozenset(eligible.intersection(candidates))

            launcher = _Launcher(profile.database)
            async with ArtifactProcessingSupervisor(
                database=profile.database,
                bindings=(
                    ArtifactProcessingBinding(
                        "memory-binding", "memory", launcher, source_count_scope_filter=count_filter
                    ),
                ),
                lease_mode="single-process",
                oceanbase_tick_seconds=0.01,
            ) as supervisor:
                await _wait(lambda: supervisor.family_status["memory"]["completed"] == 1)
                assert [work.scope_id for work in launcher.assignments] == [scopes[-1]]
                # A lineage-only write need not send a supervisor wake. Polling
                # must revisit a previously scanned scope below the threshold.
                eligible.add(scopes[0])
                await _wait(lambda: supervisor.family_status["memory"]["completed"] == 2)
                assert [work.scope_id for work in launcher.assignments] == [scopes[-1], scopes[0]]

    asyncio.run(scenario())
