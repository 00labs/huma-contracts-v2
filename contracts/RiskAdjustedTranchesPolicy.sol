// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseTranchesPolicy} from "./BaseTranchesPolicy.sol";
import {LPConfig} from "./PoolConfig.sol";
import {SENIOR_TRANCHE, JUNIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";

/**
 * @notice RiskAdjustedTranchesPolicy is one tranche policy implementation. In this policy,
 * a percentage of the pool return is shifted from the senior tranche to the junior tranche.
 */
contract RiskAdjustedTranchesPolicy is BaseTranchesPolicy {
    /**
     * @dev Ignores solhint warning, it can't be view function because it implements ITranchesPolicy's disProfitToTranches.
     */
    function _distributeProfitForSeniorTranche(
        uint256 profit,
        uint96[2] memory assets
    ) internal virtual override returns (uint256 seniorProfit, uint256 remainingProfit) {
        uint256 seniorAssets = assets[SENIOR_TRANCHE];
        uint256 juniorAssets = assets[JUNIOR_TRANCHE];

        seniorProfit = (profit * seniorAssets) / (seniorAssets + juniorAssets);

        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 profitAdjustment = (seniorProfit * lpConfig.tranchesRiskAdjustmentInBps) /
            HUNDRED_PERCENT_IN_BPS;
        seniorProfit = seniorProfit - profitAdjustment;
        remainingProfit = profit - seniorProfit;

        return (seniorProfit, remainingProfit);
    }
}
