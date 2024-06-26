// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {LPConfig} from "../common/PoolConfig.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "../common/SharedDefs.sol";

/**
 * @notice RiskAdjustedTranchesPolicy is one tranche policy implementation. In this policy,
 * a percentage of the pool return is shifted from the senior tranche to the junior tranche.
 */
contract RiskAdjustedTranchesPolicy is BaseTranchesPolicy {
    function _calcProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual override returns (uint256 seniorProfit, uint256 remainingProfit) {
        uint256 seniorAssets = assets[SENIOR_TRANCHE];
        uint256 juniorAssets = assets[JUNIOR_TRANCHE];

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        // If we disregard rounding errors, the following calculation is mathematically equivalent to:
        // seniorProfit = profit * seniorAssets / (seniorAssets + juniorAssets)
        // seniorProfit -= seniorProfit * lpConfig.tranchesRiskAdjustmentInBps / HUNDRED_PERCENT_IN_BPS
        // The two steps are combined into one to minimize rounding errors due to integer division.
        seniorProfit =
            (profit *
                seniorAssets *
                (HUNDRED_PERCENT_IN_BPS - lpConfig.tranchesRiskAdjustmentInBps)) /
            (HUNDRED_PERCENT_IN_BPS * (seniorAssets + juniorAssets));
        remainingProfit = profit - seniorProfit;
    }
}
