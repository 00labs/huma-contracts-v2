// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {Errors} from "../common/Errors.sol";
import {LPConfig, PoolConfig} from "../common/PoolConfig.sol";
import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {SENIOR_TRANCHE, DAYS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";

/**
 * @notice A tranches policy where the yield for the senior tranche is fixed as long as
 * the risk loss does not make it impossible.
 */
contract FixedSeniorYieldTranchesPolicy is BaseTranchesPolicy {
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
    ICalendar public calender;

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

        (SeniorYieldTracker memory tracker, bool updated) = _getLatestYieldTracker();
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

    function _calcProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual override returns (uint256 seniorProfit, uint256 remainingProfit) {
        (SeniorYieldTracker memory tracker, ) = _getLatestYieldTracker();

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

    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        super._updatePoolConfigData(poolConfig_);

        address addr = poolConfig_.calendar();
        assert(addr != address(0));
        calender = ICalendar(addr);
    }

    /**
     * @notice Calculates the amount of yield that the senior tranche should have earned until the current
     * block timestamp.
     * @return The (potentially) updated SeniorYieldTracker.
     * @return updated Whether the SeniorYieldTracker has been updated.
     */
    function _getLatestYieldTracker()
        internal
        view
        returns (SeniorYieldTracker memory, bool updated)
    {
        SeniorYieldTracker memory tracker = seniorYieldTracker;
        uint256 startOfNextDay = calender.getStartOfNextDay(block.timestamp);
        uint256 daysDiff = calender.getDaysDiff(tracker.lastUpdatedDate, startOfNextDay);
        if (daysDiff > 0) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            tracker.unpaidYield += uint96(
                (tracker.totalAssets * lpConfig.fixedSeniorYieldInBps * daysDiff) /
                    (DAYS_IN_A_YEAR * HUNDRED_PERCENT_IN_BPS)
            );
            tracker.lastUpdatedDate = uint64(startOfNextDay);
            updated = true;
        }

        return (tracker, updated);
    }
}
