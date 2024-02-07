// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Errors} from "../common/Errors.sol";
import {LPConfig} from "../common/PoolConfig.sol";
import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {SENIOR_TRANCHE, SECONDS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";

/**
 * @notice Tranche policy where the yield for the senior tranche is fixed as long as
 * the risk loss does not make it impossible.
 */
contract FixedSeniorYieldTranchePolicy is BaseTranchesPolicy {
    /**
     * @notice Tracks the amount of assets and unpaid yield for the senior tranche.
     * @param totalAssets The total assets in the senior tranche.
     * @param unpaidYield The amount of unpaid yield to the senior tranche.
     * @param lastUpdatedDate The last time the tracker was updated.
     */
    struct SeniorYieldTracker {
        uint96 totalAssets;
        uint96 unpaidYield;
        uint64 lastUpdatedDate;
    }

    SeniorYieldTracker public seniorYieldTracker;

    /**
     * @notice The senior yield tracker has been refreshed.
     * @param totalAssets The total assets in the senior tranche after the refresh.
     * @param unpaidYield The amount of unpaid yield to the senior tranche after the refresh.
     * @param lastUpdatedDate The last time the tracker was updated after the refresh.
     */
    event YieldTrackerRefreshed(uint256 totalAssets, uint256 unpaidYield, uint256 lastUpdatedDate);

    /// @inheritdoc BaseTranchesPolicy
    function refreshYieldTracker(uint96[2] memory assets) external override {
        if (msg.sender != address(poolConfig) && msg.sender != pool) {
            revert Errors.AuthorizedContractCallerRequired();
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
    }

    /**
     * @notice Calculates the amount of yield that the senior tranche should have earned until the current
     * block timestamp.
     * @return The (potentially) updated SeniorYieldTracker.
     * @return updated Whether the SeniorYieldTracker has been updated.
     */
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
