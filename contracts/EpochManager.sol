// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";

interface ITrancheVaultLike {
    function totalSupply() external view returns (uint256);

    function epochOrder() external view returns (uint256 totalDeposit, uint256 totalRedeem);

    function closeEpoch(uint256 epochId, uint256 price, uint256[4] memory data) external;
}

/**
 * @notice EpochManager processes epoch orders of senior tranche and junior tranche
 */

contract EpochManager {
    IDealPortfolioPool public pool;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;

    uint256 public currentEpochId;

    /**
     * @notice Closes current epoch and handle senior tranch orders and junior tranch orders
     */
    function closeEpoch() external {
        // update tranches assets to current timestamp
        uint96[2] memory tranches = pool.updatePool();

        // get tranches orders of current epoch
        (uint256 seniorDeposit, uint256 seniorRedeemShare) = seniorTranche.epochOrder();
        (uint256 juniorDeposit, uint256 juniorRedeemShare) = juniorTranche.epochOrder();

        // calculate senior/junior token price
        uint256 seniorPrice = tranches[0] / seniorTranche.totalSupply();
        uint256 juniorPrice = tranches[1] / juniorTranche.totalSupply();

        // calculate senior/junio redeem amount(underlying token amount)
        uint256 seniorRedeem = seniorRedeemShare * seniorPrice;
        uint256 juniorRedeem = juniorRedeemShare * juniorPrice;

        // process tranches orders
        uint256[4] memory results = _executeEpoch(
            tranches,
            [seniorDeposit, seniorRedeem, juniorDeposit, juniorRedeem]
        );

        uint256 epochId = currentEpochId;

        // call senior tranche's closeEpoch to update vault's epoch data
        seniorTranche.closeEpoch(
            epochId,
            seniorPrice,
            [seniorDeposit, results[0], seniorRedeem, results[1]]
        );

        // call junior tranche's closeEpoch to update vault's epoch data
        juniorTranche.closeEpoch(
            epochId,
            juniorPrice,
            [juniorRedeem, results[2], juniorRedeem, results[3]]
        );

        currentEpochId = epochId + 1;
    }

    /**
     * @notice Process tranches orders
     * @param tranches tranches assets
     * tranches[0] - senior tranche assets
     * tranches[1] - junior tranche assets
     * @param orderData order data
     * orderData[0] - the requested deposit amount of senior tranche
     * orderData[1] - the requested redeem amount of senior tranche
     * orderData[2] - the requested deposit amount of junior tranche
     * orderData[3] - the requested redeem amount of junior tranche
     * @return results result data
     * results[0] - the processed deposit amount of senior tranche
     * results[1] - the processed redeem amount of senior tranche
     * results[2] - the processed deposit amount of junior tranche
     * results[3] - the processed redeem amount of junior tranche
     */
    function _executeEpoch(
        uint96[2] memory tranches,
        uint256[4] memory orderData
    ) internal view returns (uint256[4] memory results) {
        uint256 seniorDeposit;
        uint256 seniorRedeem;
        uint256 juniorDeposit;
        uint256 juniorRedeem;

        if (orderData[0] > orderData[1]) {
            // senior deposit order > senior redeem order

            // all senior redeem order and the same amount of senior deposit order can be processed
            results[0] = orderData[1];
            results[1] = orderData[1];

            // the remaining senior deposit order
            seniorDeposit = orderData[0] - orderData[1];
        } else {
            // senior deposit order <= senior redeem order

            // all senior deposit order and the same amount of senior redeem order can be processed
            results[0] = orderData[0];
            results[1] = orderData[0];

            // the remaining senior redeem order
            seniorRedeem = orderData[1] - orderData[0];
        }

        if (orderData[2] > orderData[3]) {
            // junior deposit order > junior redeem order

            // all junior redeem order and the same amount of junior deposit order can be processed
            results[2] = orderData[3];
            results[3] = orderData[3];

            // the remaining junior deposit order
            juniorDeposit = orderData[2] - orderData[3];
        } else {
            // junior deposit order <= junior redeem order

            // all junior deposit order and the same amount of junior redeem order can be processed
            results[2] = orderData[2];
            results[3] = orderData[2];

            // the remaining junior redeem order
            juniorRedeem = orderData[3] - orderData[2];
        }

        if (juniorDeposit > 0) {
            if (seniorDeposit > 0) {
                // juniorDeposit > 0 && seniorDeposit > 0
                // check max cap for juniorDeposit
                // check max senior ratio for seniorDeposit
            } else if (seniorRedeem > 0) {
                // juniorDeposit > 0 && seniorRedeem > 0
                // check available reserve for seniorRedeem
                // check max cap for juniorDeposit
            } else {
                // juniorDeposit > 0
                // check max cap for juniorDeposit
            }
        }

        if (juniorRedeem > 0) {
            if (seniorDeposit > 0) {
                // juniorRedeem > 0 && seniorDeposit > 0
                // check max cap for seniorDeposit
                // check max senior ratio for seniorDeposit
                // check max senior ratio for juniorRedeem
                // check available reserve for juniorRedeem
            } else if (seniorRedeem > 0) {
                // juniorRedeem > 0 && seniorRedeem > 0
                // check available reserve for seniorRedeem
                // check max senior ratio for juniorRedeem
                // check available reserve for juniorRedeem
            } else {
                // juniorRedeem > 0
                // check max senior ratio for juniorRedeem
                // check available reserve for juniorRedeem
            }
        }
    }
}
