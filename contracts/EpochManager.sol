// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {ITrancheVault, EpochInfo} from "./interfaces/ITrancheVault.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract EpochManager {
    uint256 public constant SENIOR_TRANCHE_INDEX = 0;
    uint256 public constant JUNIOR_TRANCHE_INDEX = 1;
    uint256 public constant RATIO_DECIMALS = 10000;

    struct TrancheProcessedResult {
        uint256 count;
        uint256 shares;
        uint256 amounts;
    }

    struct EpochsRange {
        uint256 startIndex;
        uint256 length;
    }

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

        (
            TrancheProcessedResult memory seniorResult,
            TrancheProcessedResult memory juniorResult
        ) = _executeEpoch(tranches, seniorEpochs, seniorPrice, juniorEpochs, juniorPrice);

        EpochInfo[] memory processedEpochs;
        if (seniorResult.count > 0) {
            processedEpochs = new EpochInfo[](seniorResult.count);
            for (uint256 i; i < seniorResult.count; i++) {
                processedEpochs[i] = seniorEpochs[i];
            }
            seniorTranche.closeEpoch(processedEpochs, seniorResult.shares, seniorResult.amounts);
        }

        if (juniorResult.count > 0) {
            processedEpochs = new EpochInfo[](juniorResult.count);
            for (uint256 i; i < juniorResult.count; i++) {
                processedEpochs[i] = juniorEpochs[i];
            }
            juniorTranche.closeEpoch(processedEpochs, juniorResult.shares, juniorResult.amounts);
        }

        pool.updateTranchesAssets(tranches);

        uint256 unprocessedShares;
        for (uint256 i = seniorResult.count; i < seniorEpochs.length; i++) {
            EpochInfo memory epoch = seniorEpochs[i];
            unprocessedShares += epoch.totalShareRequested - epoch.totalShareProcessed;
        }
        uint256 unprocessedAmounts = unprocessedShares * seniorPrice;
        unprocessedShares = 0;
        for (uint256 i = juniorResult.count; i < juniorEpochs.length; i++) {
            EpochInfo memory epoch = juniorEpochs[i];
            unprocessedShares += epoch.totalShareRequested - epoch.totalShareProcessed;
        }
        unprocessedAmounts = unprocessedShares * juniorPrice;

        pool.submitRedemptionRequest(unprocessedAmounts);

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
        uint256 seniorPrice,
        EpochInfo[] memory juniorEpochs,
        uint256 juniorPrice
    )
        internal
        view
        returns (
            TrancheProcessedResult memory seniorResult,
            TrancheProcessedResult memory juniorResult
        )
    {
        // get available underlying token amount
        uint256 availableAmount = poolVault.getAvailableReservation();
        if (availableAmount <= 0) return (seniorResult, juniorResult);

        //todo fix it
        //uint256 flexPeriod = uint256(poolConfig.lpConfig().flexCallWindowInCalendarUnit());
        uint256 flexPeriod = uint256(1);
        uint256 maxEpochId = currentEpochId;

        // process mature senior withdrawal requests
        uint256 availableCount = seniorEpochs.length;
        if (flexPeriod > 0) {
            // get mature senior epochs count
            uint256 maxMatureEpochId = maxEpochId - flexPeriod;
            for (uint256 i; i < seniorEpochs.length; i++) {
                if (seniorEpochs[i].epochId <= maxMatureEpochId) {
                    availableCount += 1;
                } else {
                    break;
                }
            }
        }
        availableAmount = _processSeniorEpochs(
            tranches,
            seniorPrice,
            seniorEpochs,
            EpochsRange(0, availableCount),
            availableAmount,
            seniorResult
        );
        if (availableAmount <= 0) {
            return (seniorResult, juniorResult);
        }

        // process mature junior withdrawal requests
        availableCount = juniorEpochs.length;
        if (flexPeriod > 0) {
            // get mature junior epochs count
            uint256 maxMatureEpochId = maxEpochId - flexPeriod;
            for (uint256 i; i < juniorEpochs.length; i++) {
                if (juniorEpochs[i].epochId <= maxMatureEpochId) {
                    availableCount += 1;
                } else {
                    break;
                }
            }
        }

        //todo fix it
        //uint256 maxSeniorRatio = poolConfig.lpConfig().maxSeniorJuniorRatio()
        uint256 maxSeniorRatio = 4;
        availableAmount = _processJuniorEpochs(
            tranches,
            juniorPrice,
            maxSeniorRatio,
            juniorEpochs,
            EpochsRange(0, availableCount),
            availableAmount,
            juniorResult
        );
        if (availableAmount <= 0 || flexPeriod <= 0) {
            return (seniorResult, juniorResult);
        }

        // process immature senior withdrawal requests
        availableCount = seniorEpochs.length - seniorResult.count;
        if (availableCount > 0) {
            availableAmount = _processSeniorEpochs(
                tranches,
                seniorPrice,
                seniorEpochs,
                EpochsRange(seniorResult.count, availableCount),
                availableAmount,
                seniorResult
            );
            if (availableAmount <= 0) {
                return (seniorResult, juniorResult);
            }
        }

        // process immature junior withdrawal requests
        availableCount = juniorEpochs.length - juniorResult.count;
        if (availableCount > 0) {
            availableAmount = _processJuniorEpochs(
                tranches,
                juniorPrice,
                maxSeniorRatio,
                juniorEpochs,
                EpochsRange(juniorResult.count, availableCount),
                availableAmount,
                juniorResult
            );
            if (availableAmount <= 0) {
                return (seniorResult, juniorResult);
            }
        }
    }

    function _processSeniorEpochs(
        uint96[2] memory tranches,
        uint256 price,
        EpochInfo[] memory epochs,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        TrancheProcessedResult memory trancheResult
    ) internal pure returns (uint256 remainingAmount) {
        for (uint256 i = epochsRange.startIndex; i < epochsRange.length; i++) {
            EpochInfo memory epochInfo = epochs[i];
            uint256 shares = epochInfo.totalShareRequested - epochInfo.totalShareProcessed;
            uint256 amounts = shares * price;
            if (availableAmount < amounts) {
                amounts = availableAmount;
                shares = amounts / price;
            }
            epochInfo.totalShareProcessed += uint96(shares);
            epochInfo.totalAmountProcessed += uint96(amounts);
            availableAmount -= amounts;

            trancheResult.count += 1;
            trancheResult.shares += shares;
            trancheResult.amounts += amounts;

            if (availableAmount == 0) break;
        }

        remainingAmount = availableAmount;
        tranches[SENIOR_TRANCHE_INDEX] -= uint96(trancheResult.amounts);
    }

    function _processJuniorEpochs(
        uint96[2] memory tranches,
        uint256 price,
        uint256 maxSeniorRatio,
        EpochInfo[] memory epochs,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        TrancheProcessedResult memory trancheResult
    ) internal pure returns (uint256 remainingAmount) {
        uint256 maxJuniorAmounts = (tranches[SENIOR_TRANCHE_INDEX] * RATIO_DECIMALS) /
            maxSeniorRatio;
        uint256 maxAmounts = maxJuniorAmounts > tranches[JUNIOR_TRANCHE_INDEX]
            ? maxJuniorAmounts - tranches[JUNIOR_TRANCHE_INDEX]
            : 0;

        if (maxAmounts <= 0) return availableAmount;

        for (uint256 i = epochsRange.startIndex; i < epochsRange.length; i++) {
            EpochInfo memory epochInfo = epochs[i];
            uint256 shares = epochInfo.totalShareRequested - epochInfo.totalShareProcessed;
            uint256 amounts = shares * price;
            if (availableAmount < amounts) {
                amounts = availableAmount;
            }
            if (maxAmounts < amounts) {
                amounts = maxAmounts;
            }

            shares = amounts / price;
            epochInfo.totalShareProcessed += uint96(shares);
            epochInfo.totalAmountProcessed += uint96(amounts);
            availableAmount -= amounts;
            maxAmounts -= amounts;
            tranches[JUNIOR_TRANCHE_INDEX] -= uint96(amounts);

            trancheResult.count += 1;
            trancheResult.shares += shares;
            trancheResult.amounts += amounts;

            if (availableAmount == 0 || maxAmounts == 0) break;
        }

        remainingAmount = availableAmount;
    }
}
