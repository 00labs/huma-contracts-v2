// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";

abstract contract BaseTranchesPolicy is PoolConfigCache, ITranchesPolicy {
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {}

    /// @inheritdoc ITranchesPolicy
    function distLossToTranches(
        uint256 loss,
        uint96[2] memory assets
    ) external pure returns (uint96[2] memory updatedAssets, uint96[2] memory losses) {
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE];
        // Distribute losses to junior tranche up to the total junior asset
        losses[JUNIOR_TRANCHE] = uint96(juniorTotalAssets >= loss ? loss : juniorTotalAssets);
        losses[SENIOR_TRANCHE] = uint96(loss - losses[JUNIOR_TRANCHE]);
        updatedAssets[JUNIOR_TRANCHE] = uint96(assets[JUNIOR_TRANCHE] - losses[JUNIOR_TRANCHE]);
        updatedAssets[SENIOR_TRANCHE] = uint96(assets[SENIOR_TRANCHE] - losses[SENIOR_TRANCHE]);

        return (updatedAssets, losses);
    }

    /// @inheritdoc ITranchesPolicy
    function distLossRecoveryToTranches(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external pure returns (uint256 remainingLossRecovery, uint96[2] memory, uint96[2] memory) {
        uint96 seniorLoss = losses[SENIOR_TRANCHE];
        // Allocates recovery to senior first, up to the total senior losses
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets[SENIOR_TRANCHE] += uint96(seniorLossRecovery);
            losses[SENIOR_TRANCHE] -= uint96(seniorLossRecovery);
        }

        remainingLossRecovery = lossRecovery - seniorLossRecovery;
        if (remainingLossRecovery > 0) {
            uint96 juniorLoss = losses[JUNIOR_TRANCHE];
            uint256 juniorLossRecovery = remainingLossRecovery >= juniorLoss
                ? juniorLoss
                : remainingLossRecovery;
            assets[JUNIOR_TRANCHE] += uint96(juniorLossRecovery);
            losses[JUNIOR_TRANCHE] -= uint96(juniorLossRecovery);
            remainingLossRecovery = remainingLossRecovery - juniorLossRecovery;
        }

        return (remainingLossRecovery, assets, losses);
    }

    /// @inheritdoc ITranchesPolicy
    function refreshTracker(uint96[2] memory assets) public virtual {
        // Empty function for RiskAdjustedTranchePolicy
    }
}
