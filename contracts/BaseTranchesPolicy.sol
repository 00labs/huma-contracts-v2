// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {Errors} from "./Errors.sol";
import "./SharedDefs.sol";

abstract contract BaseTranchesPolicy is ITranchesPolicy {
    PoolConfig public poolConfig;

    constructor(PoolConfig _poolConfig) {
        if (address(_poolConfig) == address(0)) revert Errors.zeroAddressProvided();
        poolConfig = _poolConfig;
    }

    function distributeLoss(
        uint256 loss,
        uint96[2] memory assets
    ) external pure returns (uint96[2] memory newAssets) {
        // The junior tranches covers the loss first
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        newAssets[JUNIOR_TRANCHE_INDEX] = uint96(assets[JUNIOR_TRANCHE_INDEX] - juniorLoss);
        newAssets[SENIOR_TRANCHE_INDEX] = uint96(assets[SENIOR_TRANCHE_INDEX] + juniorLoss - loss);
    }

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    )
        external
        pure
        returns (uint256 newLossRecovery, uint96[2] memory newAssets, uint96[2] memory newLosses)
    {
        newAssets = assets;
        newLosses = losses;

        uint96 seniorLoss = losses[SENIOR_TRANCHE_INDEX];
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            newAssets[SENIOR_TRANCHE_INDEX] =
                assets[SENIOR_TRANCHE_INDEX] +
                uint96(seniorLossRecovery);
            newLosses[SENIOR_TRANCHE_INDEX] =
                losses[SENIOR_TRANCHE_INDEX] -
                uint96(seniorLossRecovery);
        }
        newLossRecovery = lossRecovery - seniorLossRecovery;
        if (newLossRecovery > 0) {
            uint96 juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
            uint256 juniorLossRecovery = newLossRecovery >= juniorLoss
                ? juniorLoss
                : newLossRecovery;
            newAssets[JUNIOR_TRANCHE_INDEX] =
                assets[JUNIOR_TRANCHE_INDEX] +
                uint96(juniorLossRecovery);
            newLosses[JUNIOR_TRANCHE_INDEX] =
                losses[JUNIOR_TRANCHE_INDEX] -
                uint96(juniorLossRecovery);
            newLossRecovery = newLossRecovery - juniorLossRecovery;
        }
    }
}
