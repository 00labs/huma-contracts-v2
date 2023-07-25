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

    function distributeLoss(uint256 loss, uint96[2] memory assets) external pure {
        // question assume this is more of libaray, no need to worry about access control?
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        assets[JUNIOR_TRANCHE_INDEX] = uint96(assets[JUNIOR_TRANCHE_INDEX] - juniorLoss);
        assets[SENIOR_TRANCHE_INDEX] = uint96(assets[SENIOR_TRANCHE_INDEX] + juniorLoss - loss);
        // question  what is the return value?
    }

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external pure {
        // question assume this is more of libaray, no need to worry about access control?
        uint96 seniorLoss = losses[SENIOR_TRANCHE_INDEX];
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets[SENIOR_TRANCHE_INDEX] += uint96(seniorLossRecovery);
            losses[SENIOR_TRANCHE_INDEX] -= uint96(seniorLossRecovery);
        }
        uint256 juniorLossRecovery = lossRecovery - seniorLossRecovery;
        if (juniorLossRecovery > 0) {
            assets[JUNIOR_TRANCHE_INDEX] += uint96(juniorLossRecovery);
            losses[JUNIOR_TRANCHE_INDEX] -= uint96(juniorLossRecovery);
        }
        // question what is the return value?
    }
}
