// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

abstract contract BaseTranchesPolicy is PoolConfigCache, ITranchesPolicy {
    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {}

    function calcTranchesAssetsForLoss(
        uint256 loss,
        uint96[2] memory assets
    ) external pure returns (uint96[2] memory newAssets, uint96[2] memory newLosses) {
        // The junior tranches covers the loss first
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        uint256 seniorLoss = loss - juniorLoss;
        newAssets[JUNIOR_TRANCHE_INDEX] = uint96(assets[JUNIOR_TRANCHE_INDEX] - juniorLoss);
        newAssets[SENIOR_TRANCHE_INDEX] = uint96(assets[SENIOR_TRANCHE_INDEX] - seniorLoss);
        newLosses[JUNIOR_TRANCHE_INDEX] = uint96(juniorLoss);
        newLosses[SENIOR_TRANCHE_INDEX] = uint96(seniorLoss);
    }

    function calcTranchesAssetsForLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    )
        external
        pure
        returns (uint256 newLossRecovery, uint96[2] memory newAssets, uint96[2] memory newLosses)
    {
        uint96 seniorLoss = losses[SENIOR_TRANCHE_INDEX];
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets[SENIOR_TRANCHE_INDEX] =
                assets[SENIOR_TRANCHE_INDEX] +
                uint96(seniorLossRecovery);
            losses[SENIOR_TRANCHE_INDEX] =
                losses[SENIOR_TRANCHE_INDEX] -
                uint96(seniorLossRecovery);
        }
        newLossRecovery = lossRecovery - seniorLossRecovery;
        if (newLossRecovery > 0) {
            uint96 juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
            uint256 juniorLossRecovery = newLossRecovery >= juniorLoss
                ? juniorLoss
                : newLossRecovery;
            assets[JUNIOR_TRANCHE_INDEX] =
                assets[JUNIOR_TRANCHE_INDEX] +
                uint96(juniorLossRecovery);
            losses[JUNIOR_TRANCHE_INDEX] =
                losses[JUNIOR_TRANCHE_INDEX] -
                uint96(juniorLossRecovery);
            newLossRecovery = newLossRecovery - juniorLossRecovery;
        }

        return (newLossRecovery, assets, losses);
    }
}
