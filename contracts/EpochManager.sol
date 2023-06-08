// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IDealPortfolioPool} from "./IDealPortfolioPool.sol";

interface ITrancheVaultLike {
    function totalSupply() external view returns (uint256);

    function epochOrder() external view returns (uint256 totalDeposit, uint256 totalRedeem);

    function closeEpoch(uint256 epochId, uint256 price, uint256[4] memory data) external;
}

struct EpochIds {
    uint64 currentEpochId;
    uint64 lastExecutedEpochId;
}

contract EpochManager {
    IDealPortfolioPool public pool;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;

    EpochIds internal _epochIds;

    function closeEpoch() external {
        uint96[] memory tranches = pool.updatePool();

        (uint256 seniorDeposit, uint256 seniorRedeemShare) = seniorTranche.epochOrder();
        (uint256 juniorDeposit, uint256 juniorRedeemShare) = juniorTranche.epochOrder();

        uint256 seniorPrice = tranches[0] / seniorTranche.totalSupply();
        uint256 juniorPrice = tranches[1] / juniorTranche.totalSupply();

        uint256 seniorRedeem = seniorRedeemShare * seniorPrice;
        uint256 juniorRedeem = juniorRedeemShare * juniorPrice;

        uint256[4] memory results = _executeEpoch(
            tranches,
            [seniorDeposit, seniorRedeem, juniorDeposit, juniorRedeem]
        );

        EpochIds memory ids = _epochIds;
        seniorTranche.closeEpoch(
            ids.lastExecutedEpochId + 1,
            seniorPrice,
            [seniorDeposit, results[0], seniorRedeem, results[1]]
        );

        juniorTranche.closeEpoch(
            ids.lastExecutedEpochId + 1,
            juniorPrice,
            [juniorRedeem, results[2], juniorRedeem, results[3]]
        );

        _epochIds = EpochIds(ids.currentEpochId + 1, ids.currentEpochId);
    }

    function epochIds()
        external
        view
        returns (uint256 currentEpochId, uint256 lastExecutedEpochId)
    {
        EpochIds memory eIds;
        currentEpochId = eIds.currentEpochId;
        lastExecutedEpochId = eIds.lastExecutedEpochId;
    }

    function _executeEpoch(
        uint96[] memory tranches,
        uint256[4] memory orderData
    ) internal view returns (uint256[4] memory results) {
        uint256 seniorDeposit;
        uint256 seniorRedeem;
        uint256 juniorDeposit;
        uint256 juniorRedeem;

        if (orderData[0] > orderData[1]) {
            results[0] = orderData[1];
            results[1] = orderData[1];
            seniorDeposit = orderData[0] - orderData[1];
        } else {
            results[0] = orderData[0];
            results[1] = orderData[0];
            seniorRedeem = orderData[1] - orderData[0];
        }

        if (orderData[2] > orderData[3]) {
            results[2] = orderData[3];
            results[3] = orderData[3];
            juniorDeposit = orderData[2] - orderData[3];
        } else {
            results[2] = orderData[2];
            results[3] = orderData[2];
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
