// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

/**
 * @notice RiskAdjustedTranchesPolicy is one tranche policy implementation. In this policy,
 * a percentage of the pool return is shifted from the senior tranche to the junior tranche.
 */
contract RiskAdjustedTranchesPolicy is BaseTranchesPolicy {
    /**
     * @notice Distribute profit between tranches.
     */
    function calcTranchesAssetsForProfit(
        uint256 profit,
        uint96[2] memory assets,
        uint256 lastUpdatedTime
    ) external view returns (uint96[2] memory newAssets) {
        uint256 seniorAssets = assets[SENIOR_TRANCHE];
        uint256 juniorAssets = assets[JUNIOR_TRANCHE];
        uint256 seniorProfit = (profit * seniorAssets) / (seniorAssets + juniorAssets);

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 profitAdjustment = (seniorProfit * lpConfig.tranchesRiskAdjustmentInBps) /
            HUNDRED_PERCENT_IN_BPS;
        seniorProfit = seniorProfit - profitAdjustment;

        newAssets[SENIOR_TRANCHE] = uint96(seniorAssets + seniorProfit);
        newAssets[JUNIOR_TRANCHE] = uint96(juniorAssets + profit - seniorProfit);
        return newAssets;
    }
}
