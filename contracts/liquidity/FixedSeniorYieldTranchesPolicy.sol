// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../common/Errors.sol";
import {LPConfig, PoolConfig} from "../common/PoolConfig.sol";
import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {SENIOR_TRANCHE, SECONDS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";

/**
 * @notice Tranche policy when the yield for the senior tranche is fixed as long as
 * the risk loss does not make it impossible.
 */
contract FixedSeniorYieldTranchePolicy is BaseTranchesPolicy {
    struct SeniorYieldTracker {
        uint96 totalAssets;
        uint96 unpaidYield;
        uint64 lastUpdatedDate;
    }

    SeniorYieldTracker public seniorYieldTracker;

    event YieldTrackerRefreshed(uint256 totalAssets, uint256 unpaidYield, uint256 lastUpdatedDate);

    function refreshYieldTracker(uint96[2] memory assets) external override {
        if (msg.sender != address(poolConfig) && msg.sender != pool) {
            revert Errors.AuthorizedContractRequired();
        }

        (SeniorYieldTracker memory tracker, bool updated) = _getYieldTracker();
        if (tracker.totalAssets != assets[SENIOR_TRANCHE]) {
            tracker.totalAssets = assets[SENIOR_TRANCHE];
            updated = true;
        }
        if (updated) {
            seniorYieldTracker = tracker;
            emit YieldTrackerRefreshed(
                tracker.totalAssets,
                tracker.unpaidYield,
                tracker.lastUpdatedDate
            );
        }
    }

    function _distributeProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual override returns (uint256 seniorProfit, uint256 remainingProfit) {
        // Accrues senior tranches yield to the current block timestamp first
        (SeniorYieldTracker memory tracker, ) = _getYieldTracker();

        seniorProfit = tracker.unpaidYield > profit ? profit : tracker.unpaidYield;
        remainingProfit = profit - seniorProfit;

        tracker.unpaidYield -= uint96(seniorProfit);
        tracker.totalAssets = uint96(assets[SENIOR_TRANCHE] + seniorProfit);
        seniorYieldTracker = tracker;

        emit YieldTrackerRefreshed(
            tracker.totalAssets,
            tracker.unpaidYield,
            tracker.lastUpdatedDate
        );

        return (seniorProfit, remainingProfit);
    }

    function _getYieldTracker() internal view returns (SeniorYieldTracker memory, bool updated) {
        SeniorYieldTracker memory tracker = seniorYieldTracker;
        if (block.timestamp > tracker.lastUpdatedDate) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            tracker.unpaidYield += uint96(
                (tracker.totalAssets *
                    lpConfig.fixedSeniorYieldInBps *
                    (block.timestamp - tracker.lastUpdatedDate)) /
                    (SECONDS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );
            tracker.lastUpdatedDate = uint64(block.timestamp);
            updated = true;
        }

        return (tracker, updated);
    }
}
