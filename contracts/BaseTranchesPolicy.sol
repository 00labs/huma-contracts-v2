// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import "./Constants.sol";

abstract contract BaseTranchesPolicy is ITranchesPolicy {
    function distributeLoss(uint256 loss, uint96[2] memory assets) external pure {
        uint256 juniorTotalAssets = assets[JUNIOR_TRANCHE_INDEX];
        uint256 juniorLoss = juniorTotalAssets >= loss ? loss : juniorTotalAssets;
        assets[JUNIOR_TRANCHE_INDEX] = uint96(assets[JUNIOR_TRANCHE_INDEX] - juniorLoss);
        assets[SENIOR_TRANCHE_INDEX] = uint96(assets[SENIOR_TRANCHE_INDEX] + juniorLoss - loss);
    }

    function distributeLossRecovery(
        uint256 lossRecovery,
        uint96[2] memory assets,
        uint96[2] memory losses
    ) external pure {
        uint96 seniorLoss = losses[SENIOR_TRANCHE_INDEX];
        uint256 seniorLossRecovery = lossRecovery >= seniorLoss ? seniorLoss : lossRecovery;
        if (seniorLossRecovery > 0) {
            assets[SENIOR_TRANCHE_INDEX] += uint96(seniorLossRecovery);
            losses[SENIOR_TRANCHE_INDEX] -= uint96(seniorLossRecovery);
        }
        if (lossRecovery > seniorLossRecovery) {
            assets[JUNIOR_TRANCHE_INDEX] += uint96(lossRecovery - seniorLossRecovery);
            losses[JUNIOR_TRANCHE_INDEX] -= uint96(lossRecovery - seniorLossRecovery);
        }
    }
}
