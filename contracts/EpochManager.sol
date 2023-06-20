// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IDealPortfolioPool} from "./interfaces/IDealPortfolioPool.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";
import {IReserve} from "./interfaces/IReserve.sol";

contract EpochManager {
    uint256 public flexLoanPeriod;

    IDealPortfolioPool public pool;
    IReserve public reserve;
    ITrancheVault public seniorTranche;
    ITrancheVault public juniorTranche;

    uint256 public currentEpochId;

    /**
     * @notice Closes current epoch and handle senior tranch orders and junior tranch orders
     */
    function closeEpoch() public virtual {
        // update tranches assets to current timestamp
        uint96[2] memory tranches = pool.updatePool();

        // calculate senior/junior token price
        uint256 seniorPrice = tranches[0] / seniorTranche.totalSupply();
        uint256 juniorPrice = tranches[1] / juniorTranche.totalSupply();

        // get unprocessed withdrawal requests
        EpochInfo[] memory seniorEpochs = seniorTranche.unprocessedEpochInfos();
        EpochInfo[] memory juniorEpochs = juniorTranche.unprocessedEpochInfos();

        // process withdrawal requests
        (uint256 seniorProcessedCount, uint256 juniorProcessedCount) = _executeEpoch(
            tranches,
            seniorEpochs,
            juniorEpochs
        );

        uint256 epochId = currentEpochId;

        EpochInfo[] memory processedEpochs;
        // call senior tranche's closeEpoch to update vault's epochs
        // get processed senior epochs
        seniorTranche.closeEpoch(processedEpochs);

        // call junior tranche's closeEpoch to update vault's epoch data
        // get processed junior epochs
        juniorTranche.closeEpoch(processedEpochs);

        // generate callable amount from unprocessed epochs

        currentEpochId = epochId + 1;
    }

    /**
     * @notice Process tranches orders
     * @param tranches tranches assets
     * tranches[0] - senior tranche assets
     * tranches[1] - junior tranche assets
     */
    function _executeEpoch(
        uint96[2] memory tranches,
        EpochInfo[] memory seniorEpochs,
        EpochInfo[] memory juniorEpochs
    ) internal returns (uint256 seniorProcessedCount, uint256 juniorProcessedCount) {
        // get available underlying token amount
        uint256 availableAmount = reserve.getAvailableWithdrawAmount();
        if (availableAmount <= 0) return (0, 0);

        uint256 flexPeriod = flexLoanPeriod;

        // process mature senior withdrawal requests

        // get mature senior withdrawal requests
        EpochInfo[] memory sEpochs;
        uint256 count;

        (availableAmount, count) = _processSeniorEpochs(tranches, sEpochs, availableAmount);
        seniorProcessedCount += count;
        if (availableAmount <= 0) return (seniorProcessedCount, juniorProcessedCount);

        // process mature junior withdrawal requests

        // get mature junior withdrawal requests
        EpochInfo[] memory jEpochs;

        (availableAmount, count) = _processJuniorEpochs(tranches, jEpochs, availableAmount);
        juniorProcessedCount += count;

        if (availableAmount <= 0 || flexPeriod <= 0)
            return (seniorProcessedCount, juniorProcessedCount);

        // process immature senior withdrawal requests

        // get immature senior withdrawal requests

        (availableAmount, count) = _processSeniorEpochs(tranches, sEpochs, availableAmount);
        seniorProcessedCount += count;
        if (availableAmount <= 0) return (seniorProcessedCount, juniorProcessedCount);

        // process immature senior withdrawal requests

        // get immature junior withdrawal requests

        (availableAmount, count) = _processJuniorEpochs(tranches, jEpochs, availableAmount);
        juniorProcessedCount += count;
    }

    function _processSeniorEpochs(
        uint96[2] memory tranches,
        EpochInfo[] memory seniorEpochs,
        uint256 availableAmount
    ) internal returns (uint256 remainingAmount, uint256 newProcessedCount) {}

    function _processJuniorEpochs(
        uint96[2] memory tranches,
        EpochInfo[] memory juniorEpochs,
        uint256 availableAmount
    ) internal returns (uint256 remainingAmount, uint256 newProcessedCount) {}
}
