// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract EpochManager {
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;

    IPool public pool;
    PoolConfig public poolConfig;
    IPoolVault public poolVault;
    ITrancheVault public seniorTranche;
    ITrancheVault public juniorTranche;

    uint256 public currentEpochId;

    /**
     * @notice Closes current epoch and handle senior tranch orders and junior tranch orders
     */
    function closeEpoch() public virtual {
        // update tranches assets to current timestamp
        uint96[2] memory tranches = pool.refreshPool();

        // calculate senior/junior token price
        uint256 seniorPrice = tranches[SENIOR_TRANCHE_INDEX] / seniorTranche.totalSupply();
        uint256 juniorPrice = tranches[JUNIOR_TRANCHE_INDEX] / juniorTranche.totalSupply();

        // get unprocessed withdrawal requests
        EpochInfo[] memory seniorEpochs = seniorTranche.unprocessedEpochInfos();
        EpochInfo[] memory juniorEpochs = juniorTranche.unprocessedEpochInfos();

        // process withdrawal requests
        (uint256 seniorProcessedCount, uint256 juniorProcessedCount) = _executeEpoch(
            tranches,
            seniorEpochs,
            juniorEpochs
        );

        EpochInfo[] memory processedEpochs;
        if (seniorProcessedCount > 0) {
            processedEpochs = new EpochInfo[](seniorProcessedCount);
            for (uint256 i; i < seniorProcessedCount; i++) {
                processedEpochs[i] = seniorEpochs[i];
            }
            seniorTranche.closeEpoch(processedEpochs);
        }

        if (juniorProcessedCount > 0) {
            processedEpochs = new EpochInfo[](juniorProcessedCount);
            for (uint256 i; i < juniorProcessedCount; i++) {
                processedEpochs[i] = juniorEpochs[i];
            }
            juniorTranche.closeEpoch(processedEpochs);
        }

        uint256 epochId = currentEpochId;
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
        uint256 availableAmount = poolVault.getAvailableLiquidity();
        if (availableAmount <= 0) return (0, 0);

        uint256 flexPeriod = poolConfig.flexLoanPeriod();

        // process mature senior withdrawal requests

        EpochInfo[] memory sEpochs;
        uint256 count;

        // :get mature senior withdrawal requests
        (availableAmount, count) = _processSeniorEpochs(tranches, sEpochs, availableAmount);
        seniorProcessedCount += count;
        if (availableAmount <= 0) return (seniorProcessedCount, juniorProcessedCount);

        // process mature junior withdrawal requests

        EpochInfo[] memory jEpochs;

        // :get mature junior withdrawal requests
        (availableAmount, count) = _processJuniorEpochs(tranches, jEpochs, availableAmount);
        juniorProcessedCount += count;

        if (availableAmount <= 0 || flexPeriod <= 0)
            return (seniorProcessedCount, juniorProcessedCount);

        // process immature senior withdrawal requests

        // :get immature senior withdrawal requests
        (availableAmount, count) = _processSeniorEpochs(tranches, sEpochs, availableAmount);
        seniorProcessedCount += count;
        if (availableAmount <= 0) return (seniorProcessedCount, juniorProcessedCount);

        // process immature senior withdrawal requests

        // :get immature junior withdrawal requests
        (availableAmount, count) = _processJuniorEpochs(tranches, jEpochs, availableAmount);
        juniorProcessedCount += count;

        uint256 printcipalWithdrawalAmount;
        // :generate callable amount from unprocessed epochs
        if (flexPeriod > 0) {
            pool.submitPrincipalWithdrawal(printcipalWithdrawalAmount);
        }
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
