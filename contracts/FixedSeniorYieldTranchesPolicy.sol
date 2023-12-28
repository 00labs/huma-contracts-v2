// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {LPConfig} from "./PoolConfig.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE, SECONDS_IN_A_YEAR, HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";

import "hardhat/console.sol";

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

    event YieldTrackerRefreshed(uint256 totalAssets, uint256 unpaidYield, uint256 lastUpdatedDate);

    address public pool;
    SeniorYieldTracker public seniorYieldTracker;

    function refreshYieldTracker(uint96[2] memory assets) public override {
        if (msg.sender != address(poolConfig) && msg.sender != pool) {
            revert Errors.todo();
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

    function distProfitToTranches(
        uint256 profit,
        uint96[2] memory assets
    ) external returns (uint96[2] memory newAssets) {
        // Accrues senior tranches yield to the current block timestamp first
        (SeniorYieldTracker memory tracker, ) = _getYieldTracker();

        uint256 seniorProfit = tracker.unpaidYield > profit ? profit : tracker.unpaidYield;
        uint256 juniorProfit = profit - seniorProfit;

        newAssets[SENIOR_TRANCHE] = assets[SENIOR_TRANCHE] + uint96(seniorProfit);
        newAssets[JUNIOR_TRANCHE] = assets[JUNIOR_TRANCHE] + uint96(juniorProfit);

        tracker.unpaidYield -= uint96(seniorProfit);
        tracker.totalAssets = newAssets[SENIOR_TRANCHE];
        seniorYieldTracker = tracker;

        emit YieldTrackerRefreshed(
            tracker.totalAssets,
            tracker.unpaidYield,
            tracker.lastUpdatedDate
        );

        return newAssets;
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = addr;
    }

    function _getYieldTracker() public view returns (SeniorYieldTracker memory, bool updated) {
        SeniorYieldTracker memory tracker = seniorYieldTracker;
        if (block.timestamp > tracker.lastUpdatedDate) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            // TODO: should round down (correct).
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
