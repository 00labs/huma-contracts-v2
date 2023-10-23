// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, PoolSettings, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IEpoch, EpochInfo} from "./interfaces/IEpoch.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {DEFAULT_DECIMALS_FACTOR, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {ICalendar} from "./credit/interfaces/ICalendar.sol";

interface ITrancheVaultLike is IEpoch {
    function totalSupply() external view returns (uint256);
}

/**
 * @title EpochManager
 * @notice EpochManager processes redemption requests at the end of each billing cycle
 */
contract EpochManager is PoolConfigCache, IEpochManager {
    struct RedemptionResult {
        uint256 numEpochsProcessed;
        uint256 sharesRedeemed;
        uint256 amountRedeemed;
    }

    struct EpochsRange {
        uint256 startIndex;
        uint256 length;
    }

    struct CurrentEpoch {
        uint64 id;
        uint64 endTime;
    }

    IPool public pool;
    IPoolSafe public poolSafe;
    ITrancheVaultLike public seniorTranche;
    ITrancheVaultLike public juniorTranche;
    ICalendar public calendar;

    CurrentEpoch internal _currentEpoch;

    event EpochClosed(
        uint256 epochId,
        uint256 seniorTrancheAssets,
        uint256 seniorTranchePrice,
        uint256 juniorTrancheAssets,
        uint256 juniorTranchePrice,
        uint256 unprocessedAmount
    );
    event NewEpochStarted(uint256 epochId, uint256 endTime);

    /**
     * @notice Syndicates the address of dependent contracts from pool config:
     * PoolSafe, Pool, Senior TrancheVault, Junior TrancheValut, and Calendar.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.seniorTranche();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        seniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.juniorTranche();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        juniorTranche = ITrancheVaultLike(addr);

        addr = _poolConfig.calendar();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        calendar = ICalendar(addr);
    }

    /**
     * @notice Closes current epoch and handles senior and junior tranche redemption requests.
     * @dev Expects to be called by a cron-like mechanism like autotask,
     * although anyone can call it to trigger epoch closure.
     */
    function closeEpoch() public virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.closeTooSoon();

        // update tranche assets to the current timestamp
        uint96[2] memory tranchesAssets = pool.refreshPool();

        // calculate senior/junior LP token prices
        uint256 seniorPrice = (tranchesAssets[SENIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            seniorTranche.totalSupply();
        uint256 juniorPrice = (tranchesAssets[JUNIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            juniorTranche.totalSupply();

        // get unprocessed redemption requests
        EpochInfo[] memory seniorEpochs = seniorTranche.unprocessedEpochInfos();
        EpochInfo[] memory juniorEpochs = juniorTranche.unprocessedEpochInfos();

        (
            RedemptionResult memory seniorResult,
            RedemptionResult memory juniorResult
        ) = _processEpoch(tranchesAssets, seniorEpochs, seniorPrice, juniorEpochs, juniorPrice);

        EpochInfo[] memory processedEpochs;
        if (seniorResult.numEpochsProcessed > 0) {
            processedEpochs = new EpochInfo[](seniorResult.numEpochsProcessed);
            for (uint256 i = 0; i < seniorResult.numEpochsProcessed; i++) {
                processedEpochs[i] = seniorEpochs[i];
            }
            seniorTranche.executeEpochs(
                processedEpochs,
                seniorResult.sharesRedeemed,
                seniorResult.amountRedeemed
            );
        }

        if (juniorResult.numEpochsProcessed > 0) {
            processedEpochs = new EpochInfo[](juniorResult.numEpochsProcessed);
            for (uint256 i = 0; i < juniorResult.numEpochsProcessed; i++) {
                processedEpochs[i] = juniorEpochs[i];
            }
            juniorTranche.executeEpochs(
                processedEpochs,
                juniorResult.sharesRedeemed,
                juniorResult.amountRedeemed
            );
        }

        pool.updateTranchesAssets(tranchesAssets);

        uint256 unprocessedShares;
        if (seniorResult.numEpochsProcessed > 0) {
            unprocessedShares =
                seniorEpochs[seniorResult.numEpochsProcessed - 1].totalSharesRequested -
                seniorEpochs[seniorResult.numEpochsProcessed - 1].totalSharesProcessed;
        }
        for (uint256 i = seniorResult.numEpochsProcessed; i < seniorEpochs.length; i++) {
            EpochInfo memory epoch = seniorEpochs[i];
            unprocessedShares += epoch.totalSharesRequested - epoch.totalSharesProcessed;
        }
        uint256 unprocessedAmount = (unprocessedShares * seniorPrice) / DEFAULT_DECIMALS_FACTOR;

        unprocessedShares = 0;
        if (juniorResult.numEpochsProcessed > 0) {
            unprocessedShares =
                juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesRequested -
                juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesProcessed;
        }
        for (uint256 i = juniorResult.numEpochsProcessed; i < juniorEpochs.length; i++) {
            EpochInfo memory epoch = juniorEpochs[i];
            unprocessedShares += epoch.totalSharesRequested - epoch.totalSharesProcessed;
        }
        unprocessedAmount += (unprocessedShares * juniorPrice) / DEFAULT_DECIMALS_FACTOR;

        // console.log(
        //     "id: %s, juniorTotalAssets: %s, seniorTotalAssets: %s",
        //     uint256(ce.id),
        //     tranches[JUNIOR_TRANCHE],
        //     tranches[SENIOR_TRANCHE]
        // );

        // console.log(
        //     "seniorPrice: %s, juniorPrice: %s, unprocessedAmount: %s",
        //     seniorPrice,
        //     juniorPrice,
        //     unprocessedAmount
        // );

        emit EpochClosed(
            ce.id,
            tranchesAssets[SENIOR_TRANCHE],
            seniorPrice,
            tranchesAssets[JUNIOR_TRANCHE],
            juniorPrice,
            unprocessedAmount
        );
        _createNextEpoch(ce);
    }

    function startNewEpoch() external {
        poolConfig.onlyPool(msg.sender);

        CurrentEpoch memory ce = _currentEpoch;
        ce.endTime = 0;
        _createNextEpoch(ce);
    }

    function _createNextEpoch(CurrentEpoch memory epoch) internal {
        epoch.id += 1;
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        (uint256 nextEndTime, ) = calendar.getNextDueDate(
            poolSettings.payPeriodInMonths,
            epoch.endTime
        );
        epoch.endTime = uint64(nextEndTime);
        _currentEpoch = epoch;

        emit NewEpochStarted(epoch.id, epoch.endTime);
    }

    function currentEpochId() external view returns (uint256) {
        return _currentEpoch.id;
    }

    function currentEpoch() external view returns (CurrentEpoch memory) {
        return _currentEpoch;
    }

    /**
     * @notice Process previously unprocessed redemption requests
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param seniorEpochs the list of unprocessed/partially processed epochs for the senior tranche
     * @param seniorPrice the senior LP token price
     * @param juniorEpochs the list of unprocessed/partially processed epochs for the junior tranche
     * @param juniorPrice the junior LP token price
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the tranches after fulfilling
     * redemption requests
     * seniorEpochs: will be updated to reflect the latest redemption request states for the senior tranche
     * juniorEpochs: will be updated to reflect the latest redemption request states for the junior tranche
     */
    function _processEpoch(
        uint96[2] memory tranchesAssets,
        EpochInfo[] memory seniorEpochs,
        uint256 seniorPrice,
        EpochInfo[] memory juniorEpochs,
        uint256 juniorPrice
    )
        internal
        view
        virtual
        returns (RedemptionResult memory seniorResult, RedemptionResult memory juniorResult)
    {
        // get available underlying token amount
        uint256 availableAmount = poolSafe.getPoolLiquidity();
        if (availableAmount <= 0) return (seniorResult, juniorResult);

        // Process senior tranche redemption requests.
        uint256 numEpochsToProcess = seniorEpochs.length;
        if (numEpochsToProcess > 0) {
            // console.log("processing mature senior withdrawal requests...");
            availableAmount = _processSeniorRedemptionRequests(
                tranchesAssets,
                seniorPrice,
                seniorEpochs,
                EpochsRange(0, numEpochsToProcess),
                availableAmount,
                seniorResult
            );
            // console.log(
            //     "seniorResult.count: %s, seniorResult.shares: %s, seniorResult.amounts: %s",
            //     seniorResult.count,
            //     seniorResult.shares,
            //     seniorResult.amounts
            // );
            if (availableAmount == 0) {
                return (seniorResult, juniorResult);
            }
        }

        // Process junior tranche redemption requests.
        numEpochsToProcess = juniorEpochs.length;
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
        if (numEpochsToProcess > 0) {
            availableAmount = _processJuniorRedemptionRequests(
                tranchesAssets,
                juniorPrice,
                maxSeniorJuniorRatio,
                juniorEpochs,
                EpochsRange(0, numEpochsToProcess),
                availableAmount,
                juniorResult
            );
            // console.log("availableAmount: %s", availableAmount);
            // console.log(
            //     "juniorResult.count: %s, juniorResult.shares: %s, juniorResult.amounts: %s",
            //     juniorResult.count,
            //     juniorResult.shares,
            //     juniorResult.amounts
            // );
            if (availableAmount == 0) {
                return (seniorResult, juniorResult);
            }
        }

        return (seniorResult, juniorResult);
    }

    /**
     * @notice Processes redemption requests for the senior tranche
     * @param tranchesAssets tranches assets indexed by SENIOR_TRANCHE or JUNIOR_TRANCHE
     * @param lpTokenPrice the price of the senior LP tokens
     * @param epochInfos the list of epoch infos in each epoch for the senior tranche
     * @param epochsRange the range of epochs in the list of epoch infos to be processed
     * @param availableAmount the total amount available for redemption
     * @param redemptionResult the redemption request processing result for the senior tranche
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the senior tranche after fulfilling
     * redemption requests
     * epochInfos: will be updated to reflect the latest redemption request states for the senior tranche
     * redemptionResult: will be updated to store the processing result
     */
    function _processSeniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        EpochInfo[] memory epochInfos,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        RedemptionResult memory redemptionResult
    ) internal pure returns (uint256 remainingAmount) {
        uint256 endIndex = epochsRange.startIndex + epochsRange.length;
        for (uint256 i = epochsRange.startIndex; i < endIndex; i++) {
            EpochInfo memory epochInfo = epochInfos[i];
            // console.log(
            //     "epochInfo.epochId: %s, epochInfo.totalShareRequested: %s, epochInfo.totalShareProcessed: %s",
            //     uint256(epochInfo.epochId),
            //     uint256(epochInfo.totalShareRequested),
            //     uint256(epochInfo.totalShareProcessed)
            // );
            // console.log(
            //     "epochInfo.epochId: %s, epochInfo.totalAmountProcessed: %s",
            //     uint256(epochInfo.epochId),
            //     uint256(epochInfo.totalAmountProcessed)
            // );
            uint256 sharesToRedeem = epochInfo.totalSharesRequested -
                epochInfo.totalSharesProcessed;
            uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < redemptionAmount) {
                redemptionAmount = availableAmount;
                sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
            }
            epochInfo.totalSharesProcessed += uint96(sharesToRedeem);
            epochInfo.totalAmountProcessed += uint96(redemptionAmount);
            availableAmount -= redemptionAmount;

            // console.log(
            //     "epochInfo.totalShareProcessed: %s, epochInfo.totalAmountProcessed: %s",
            //     uint256(epochInfo.totalShareProcessed),
            //     uint256(epochInfo.totalAmountProcessed)
            // );

            redemptionResult.numEpochsProcessed += 1;
            redemptionResult.sharesRedeemed += sharesToRedeem;
            redemptionResult.amountRedeemed += redemptionAmount;
            tranchesAssets[SENIOR_TRANCHE] -= uint96(redemptionAmount);

            // console.log(
            //     "trancheResult.count: %s, trancheResult.shares: %s, trancheResult.amounts: %s",
            //     uint256(trancheResult.count),
            //     uint256(trancheResult.shares),
            //     uint256(trancheResult.amounts)
            // );

            if (availableAmount == 0) break;
        }

        remainingAmount = availableAmount;
    }

    /**
     * @notice Processes redemption requests for the junior tranche. When processing junior requests, special care
     * has to be taken to ensure that the max senior : junior ratio is not breached.
     * @param tranchesAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param lpTokenPrice the price of the junior LP tokens
     * @param epochInfos the list of epoch infos in each epoch for the junior tranche
     * @param epochsRange the range of epochs in the list of epoch infos to be processed
     * @param availableAmount the total amount available for redemption
     * @param redemptionResult the redemption request processing result for the junior tranche
     * @dev this function is side-effectual and mutates the following incoming params:
     * tranchesAssets: will be updated to reflect the remaining amount of assets in the junior tranche after fulfilling
     * redemption requests
     * epochInfos: will be updated to reflect the latest redemption request states for the senior tranche
     * redemptionResult: will be updated to store the processing result
     */
    function _processJuniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        uint256 maxSeniorJuniorRatio,
        EpochInfo[] memory epochInfos,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        RedemptionResult memory redemptionResult
    ) internal pure returns (uint256 remainingAmount) {
        // Calculate the minimum amount of junior assets required to maintain the senior : junior ratio.
        // Since integer division rounds down, add 1 to minJuniorAmount in order to maintain the ratio.
        uint256 minJuniorAmount = tranchesAssets[SENIOR_TRANCHE] / maxSeniorJuniorRatio;
        if (minJuniorAmount * maxSeniorJuniorRatio < tranchesAssets[SENIOR_TRANCHE])
            minJuniorAmount += 1;

        uint256 maxRedeemableAmount = tranchesAssets[JUNIOR_TRANCHE] > minJuniorAmount
            ? tranchesAssets[JUNIOR_TRANCHE] - minJuniorAmount
            : 0;
        if (maxRedeemableAmount <= 0) return availableAmount;

        uint256 endIndex = epochsRange.startIndex + epochsRange.length;
        for (uint256 i = epochsRange.startIndex; i < endIndex; i++) {
            EpochInfo memory epochInfo = epochInfos[i];
            uint256 sharesToRedeem = epochInfo.totalSharesRequested -
                epochInfo.totalSharesProcessed;
            uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < redemptionAmount) {
                redemptionAmount = availableAmount;
                sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
            }
            if (maxRedeemableAmount < redemptionAmount) {
                redemptionAmount = maxRedeemableAmount;
                sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
            }

            epochInfo.totalSharesProcessed += uint96(sharesToRedeem);
            epochInfo.totalAmountProcessed += uint96(redemptionAmount);
            availableAmount -= redemptionAmount;
            maxRedeemableAmount -= redemptionAmount;
            tranchesAssets[JUNIOR_TRANCHE] -= uint96(redemptionAmount);

            // If the redemption requests in the epoch were partially processed in the last round,
            // then they will be processed again in this round (by decrementing `epochsRange.startIndex` by 1 in
            // `_processEpoch`, which means the same epoch would be double-counted if we simply increment the count
            // by 1 all the time, hence the conditional increment only if the value of `i` satisfies the condition
            // below. Note that we use i + 1 > redemptionResult.numEpochsProcessed instead of
            // i > redemptionResult.numEpochsProcessed - 1 because the latter underflows if numEpochsProcessed is 0.
            if (i + 1 > redemptionResult.numEpochsProcessed)
                redemptionResult.numEpochsProcessed += 1;
            redemptionResult.sharesRedeemed += sharesToRedeem;
            redemptionResult.amountRedeemed += redemptionAmount;

            if (availableAmount == 0 || maxRedeemableAmount == 0) break;
        }

        remainingAmount = availableAmount;
    }
}
