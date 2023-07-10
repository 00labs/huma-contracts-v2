// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {Constants} from "./Constants.sol";

abstract contract BaseTranchesPolicy is Constants, ITranchesPolicy {
    function distributeLoss(uint256 loss, uint96[2] memory assets) external view {
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        assets[JUNIOR_TRANCHE_INDEX] = uint96(assets[JUNIOR_TRANCHE_INDEX] - juniorLoss);
        assets[SENIOR_TRANCHE_INDEX] = uint96(assets[SENIOR_TRANCHE_INDEX] + juniorLoss - loss);
    }

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external view {
        uint96 juniorLoss = losses[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLossRecovery = lossRecovery >= juniorLoss ? juniorLoss : lossRecovery;
        assets[JUNIOR_TRANCHE_INDEX] += uint96(juniorLossRecovery);
        losses[JUNIOR_TRANCHE_INDEX] -= uint96(juniorLossRecovery);
        if (lossRecovery > juniorLossRecovery) {
            assets[SENIOR_TRANCHE_INDEX] += uint96(lossRecovery - juniorLossRecovery);
            losses[SENIOR_TRANCHE_INDEX] -= uint96(lossRecovery - juniorLossRecovery);
        }
    }
}
