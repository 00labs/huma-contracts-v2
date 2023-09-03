// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, PoolSettings, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IEpoch, EpochRedemptionSummary} from "./interfaces/IEpoch.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";
import "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {ICalendar} from "./credit/interfaces/ICalendar.sol";

import "hardhat/console.sol";

interface ITrancheVaultLike is IEpoch {
    function totalSupply() external view returns (uint256);
}

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
    IPoolVault public poolVault;
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

    constructor(address poolConfigAddress) PoolConfigCache(poolConfigAddress) {}

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

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
     * @notice Closes current epoch and handles senior and junior tranche orders,
     * @dev The intention is for this function to be called by a cron-like mechanism like autotask,
     * although anyone can call it to trigger epoch closure.
     */
    function closeEpoch() public virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.closeTooSoon();

        // update tranche assets to current timestamp
        uint96[2] memory trancheAssets = pool.refreshPool();

        // calculate senior/junior LP token price
        uint256 seniorLPTokenPrice = (trancheAssets[SENIOR_TRANCHE_INDEX] * DEFAULT_DECIMALS_FACTOR) /
            seniorTranche.totalSupply();
        uint256 juniorLPTokenPrice = (trancheAssets[JUNIOR_TRANCHE_INDEX] * DEFAULT_DECIMALS_FACTOR) /
            juniorTranche.totalSupply();

        // get unprocessed redemption requests
        EpochRedemptionSummary[] memory seniorEpochs = seniorTranche.unprocessedEpochSummaries();
        EpochRedemptionSummary[] memory juniorEpochs = juniorTranche.unprocessedEpochSummaries();

        (
            RedemptionResult memory seniorResult,
            RedemptionResult memory juniorResult
        ) = _executeEpoch(trancheAssets, seniorEpochs, seniorLPTokenPrice, juniorEpochs, juniorLPTokenPrice);

        EpochRedemptionSummary[] memory processedEpochs;
        if (seniorResult.numEpochsProcessed > 0) {
            processedEpochs = new EpochRedemptionSummary[](seniorResult.numEpochsProcessed);
            for (uint256 i; i < seniorResult.numEpochsProcessed; i++) {
                processedEpochs[i] = seniorEpochs[i];
            }
            seniorTranche.processEpochs(
                processedEpochs,
                seniorResult.sharesRedeemed,
                seniorResult.amountRedeemed
            );
        }

        if (juniorResult.numEpochsProcessed > 0) {
            processedEpochs = new EpochRedemptionSummary[](juniorResult.numEpochsProcessed);
            for (uint256 i; i < juniorResult.numEpochsProcessed; i++) {
                processedEpochs[i] = juniorEpochs[i];
            }
            juniorTranche.processEpochs(
                processedEpochs,
                juniorResult.sharesRedeemed,
                juniorResult.amountRedeemed
            );
        }

        pool.updateTrancheAssets(trancheAssets);

        uint256 unprocessedShares;
        if (seniorResult.numEpochsProcessed > 0) {
            unprocessedShares =
                seniorEpochs[seniorResult.numEpochsProcessed - 1].totalSharesRequested -
                seniorEpochs[seniorResult.numEpochsProcessed - 1].totalSharesProcessed;
        }
        for (uint256 i = seniorResult.numEpochsProcessed; i < seniorEpochs.length; i++) {
            EpochRedemptionSummary memory epoch = seniorEpochs[i];
            unprocessedShares += epoch.totalSharesRequested - epoch.totalSharesProcessed;
        }
        uint256 unprocessedAmounts = (unprocessedShares * seniorLPTokenPrice) / DEFAULT_DECIMALS_FACTOR;

        unprocessedShares = 0;
        if (juniorResult.numEpochsProcessed > 0) {
            unprocessedShares =
                juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesRequested -
                juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesProcessed;
        }
        for (uint256 i = juniorResult.numEpochsProcessed; i < juniorEpochs.length; i++) {
            EpochRedemptionSummary memory epoch = juniorEpochs[i];
            unprocessedShares += epoch.totalSharesRequested - epoch.totalSharesProcessed;
        }
        unprocessedAmounts += (unprocessedShares * juniorLPTokenPrice) / DEFAULT_DECIMALS_FACTOR;

        pool.submitRedemptionRequest(unprocessedAmounts);

        // console.log(
        //     "id: %s, juniorTotalAssets: %s, seniorTotalAssets: %s",
        //     uint256(ce.id),
        //     tranches[JUNIOR_TRANCHE_INDEX],
        //     tranches[SENIOR_TRANCHE_INDEX]
        // );

        // console.log(
        //     "seniorPrice: %s, juniorPrice: %s, unprocessedAmounts: %s",
        //     seniorPrice,
        //     juniorPrice,
        //     unprocessedAmounts
        // );

        emit EpochClosed(
            ce.id,
            trancheAssets[SENIOR_TRANCHE_INDEX],
            seniorLPTokenPrice,
            trancheAssets[JUNIOR_TRANCHE_INDEX],
            juniorLPTokenPrice,
            unprocessedAmounts
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
            poolSettings.calendarUnit,
            poolSettings.payPeriodInCalendarUnit,
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
     * @param trancheAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE_INDEX, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets
     * @param seniorEpochs the list of summaries of unprocessed/partially processed epochs for the senior tranche
     * @param seniorLPTokenPrice the senior LP token price
     * @param juniorEpochs the list of summaries of unprocessed/partially processed epochs for the junior tranche
     * @param juniorLPTokenPrice the junior LP token price
     * @dev this function is side-effectual and mutates the following incoming params:
     * trancheAssets: will be updated to reflect the remaining amount of assets in the tranches after fulfilling
     * redemption requests
     * seniorEpochs: will be updated to reflect the latest redemption request states for the senior tranche
     * juniorEpochs: will be updated to reflect the latest redemption request states for the junior tranche
     */
    function _executeEpoch(
        uint96[2] memory trancheAssets,
        EpochRedemptionSummary[] memory seniorEpochs,
        uint256 seniorLPTokenPrice,
        EpochRedemptionSummary[] memory juniorEpochs,
        uint256 juniorLPTokenPrice
    )
        internal
        view
        virtual
        returns (
            RedemptionResult memory seniorResult,
            RedemptionResult memory juniorResult
        )
    {
        // get available underlying token amount
        uint256 availableAmount = poolVault.totalAssets();
        // console.log("availableAmount: %s", availableAmount);
        if (availableAmount <= 0) return (seniorResult, juniorResult);

        PoolSettings memory settings = poolConfig.getPoolSettings();
        LPConfig memory lpConfig = poolConfig.getLPConfig();
        uint256 maxEpochId = _currentEpoch.id;

        // Process senior tranche redemption requests.
        uint256 numEpochsToProcess = _getNumEpochsToProcess(settings, seniorEpochs, maxEpochId);
        if (numEpochsToProcess > 0) {
            // console.log("processing mature senior withdrawal requests...");
            availableAmount = _processSeniorRedemptionRequests(
                trancheAssets,
                seniorLPTokenPrice,
                seniorEpochs,
                EpochsRange(0, numEpochsToProcess),
                availableAmount,
                seniorResult
            );
            // console.log("availableAmount: %s", availableAmount);
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
        numEpochsToProcess = _getNumEpochsToProcess(settings, juniorEpochs, maxEpochId);
        // console.log("availableCount: %s", availableCount);
        uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
        if (numEpochsToProcess > 0) {
            // console.log("processing mature junior withdrawal requests...");
            availableAmount = _processJuniorRedemptionRequests(
                trancheAssets,
                juniorLPTokenPrice,
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

        if (!settings.flexCreditEnabled) {
            return (seniorResult, juniorResult);
        }

        // For pools with flex loan, keep processing redemption requests even if they are immature, as long
        // as there are left over amount to be redeemed.
        // Process senior redemption requests first.
        numEpochsToProcess = seniorEpochs.length - seniorResult.numEpochsProcessed;
        if (numEpochsToProcess > 0) {
            // console.log("processing immature senior withdrawal requests...");
            // console.log(
            //     "seniorResult.count: %s, availableCount: %s",
            //     seniorResult.count,
            //     availableCount
            // );
            availableAmount = _processSeniorRedemptionRequests(
                trancheAssets,
                seniorLPTokenPrice,
                seniorEpochs,
                EpochsRange(seniorResult.numEpochsProcessed, numEpochsToProcess),
                availableAmount,
                seniorResult
            );
            // console.log("availableAmount: %s", availableAmount);
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

        // Then process junior redemption requests. Note that some previously ineligible junior requests
        // blocked by the max senior : junior ratio maybe eligible now due to the additional senior requests
        // being fulfilled above.
        numEpochsToProcess = juniorEpochs.length - juniorResult.numEpochsProcessed;
        uint256 startIndex = juniorResult.numEpochsProcessed;
        if (
            juniorResult.numEpochsProcessed > 0 &&
            juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesRequested >
            juniorEpochs[juniorResult.numEpochsProcessed - 1].totalSharesProcessed
        ) {
            // If the redemption requests in the last epoch processed were only partially processed, then try to
            // process the epoch again.
            startIndex -= 1;
            numEpochsToProcess += 1;
        }

        if (numEpochsToProcess > 0) {
            // console.log("processing left junior withdrawal requests...");
            availableAmount = _processJuniorRedemptionRequests(
                trancheAssets,
                juniorLPTokenPrice,
                maxSeniorJuniorRatio,
                juniorEpochs,
                EpochsRange(startIndex, numEpochsToProcess),
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
        }

        return (seniorResult, juniorResult);
    }

    /// @notice Returns the number of epochs to process.
    /// @param settings pool settings
    /// @param epochRedemptionSummaries the list of redemption summaries for each epoch
    function _getNumEpochsToProcess(PoolSettings memory settings, EpochRedemptionSummary[] memory epochRedemptionSummaries, uint256 maxEpochId) private pure returns (uint256 numEpochsToProcess) {
        if (settings.flexCreditEnabled) {
            // If flex loan is enabled for a pool, then we can only process redemption requests after the
            // the call window has passed so that the borrower can have the capital ready for redemption
            // E.g. if a redemption request is submitted in epoch 1, and the call window
            // is 2, then the redemption requests can only be processed in or after epoch 3.
            if (maxEpochId > settings.flexCallWindowInEpochs) {
                uint256 maxEligibleEpochId = maxEpochId - settings.flexCallWindowInEpochs;
                for (uint256 i; i < epochRedemptionSummaries.length; i++) {
                    if (epochRedemptionSummaries[i].epochId <= maxEligibleEpochId) {
                        numEpochsToProcess += 1;
                    } else {
                        // The epoch IDs are guaranteed to increase monotonically in the list of epochSummaries,
                        // so we can bail out of the loop at the first non-eligible epoch ID.
                        break;
                    }
                }
            }
        } else {
            // If a pool doesn't have flex loan enabled, then unprocessed redemption requests in all epochs
            // are eligible for processing.
            numEpochsToProcess = epochRedemptionSummaries.length;
        }
    }

    /// @notice Processes redemption requests for the senior tranche
    /// @param trancheAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE_INDEX, i.e. tranches[0] is the
    /// senior tranche assets and tranches[1] is the junior tranche assets
    /// @param lpTokenPrice the price of the senior LP tokens
    /// @param epochRedemptionSummaries the list of redemption summaries in each epoch for the senior tranche
    /// @param epochsRange the range of epochs in the list of redemption summaries to be processed
    /// @param availableAmount the total amount available for redemption
    /// @param processingResult the redemption request processing result for the senior tranche
    /// @dev this function is side-effectual and mutates the following incoming params:
    /// trancheAssets: will be updated to reflect the remaining amount of assets in the senior tranche after fulfilling
    /// redemption requests
    /// epochRedemptionSummaries: will be updated to reflect the latest redemption request states for the senior tranche
    /// processingResult: will be updated to store the processing result
    function _processSeniorRedemptionRequests(
        uint96[2] memory trancheAssets,
        uint256 lpTokenPrice,
        EpochRedemptionSummary[] memory epochRedemptionSummaries,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        RedemptionResult memory processingResult
    ) internal pure returns (uint256 remainingAmount) {
        uint256 endIndex = epochsRange.startIndex + epochsRange.length;
        for (uint256 i = epochsRange.startIndex; i < endIndex; i++) {
            EpochRedemptionSummary memory redemptionSummary = epochRedemptionSummaries[i];
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
            uint256 sharesToRedeem = redemptionSummary.totalSharesRequested - redemptionSummary.totalSharesProcessed;
            uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < redemptionAmount) {
                redemptionAmount = availableAmount;
                sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
            }
            redemptionSummary.totalSharesProcessed += uint96(sharesToRedeem);
            redemptionSummary.totalAmountProcessed += uint96(redemptionAmount);
            availableAmount -= redemptionAmount;

            // console.log(
            //     "epochInfo.totalShareProcessed: %s, epochInfo.totalAmountProcessed: %s",
            //     uint256(epochInfo.totalShareProcessed),
            //     uint256(epochInfo.totalAmountProcessed)
            // );

            processingResult.numEpochsProcessed += 1;
            processingResult.sharesRedeemed += sharesToRedeem;
            processingResult.amountRedeemed += redemptionAmount;
            trancheAssets[SENIOR_TRANCHE_INDEX] -= uint96(redemptionAmount);

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

    /// @notice Processes redemption requests for the junior tranche. When processing junior requests, special care
    /// has to be taken to ensure that the max senior : junior ratio is not breached.
    /// @param trancheAssets tranches assets indexed by SENIOR_ or JUNIOR_TRANCHE_INDEX, i.e. tranches[0] is the
    /// senior tranche assets and tranches[1] is the junior tranche assets
    /// @param lpTokenPrice the price of the junior LP tokens
    /// @param epochRedemptionSummaries the list of redemption summaries in each epoch for the junior tranche
    /// @param epochsRange the range of epochs in the list of redemption summaries to be processed
    /// @param availableAmount the total amount available for redemption
    /// @param processingResult the redemption request processing result for the junior tranche
    /// @dev this function is side-effectual and mutates the following incoming params:
    /// trancheAssets: will be updated to reflect the remaining amount of assets in the junior tranche after fulfilling
    /// redemption requests
    /// epochRedemptionSummaries: will be updated to reflect the latest redemption request states for the senior tranche
    /// processingResult: will be updated to store the processing result
    function _processJuniorRedemptionRequests(
        uint96[2] memory trancheAssets,
        uint256 lpTokenPrice,
        uint256 maxSeniorJuniorRatio,
        EpochRedemptionSummary[] memory epochRedemptionSummaries,
        EpochsRange memory epochsRange,
        uint256 availableAmount,
        RedemptionResult memory processingResult
    ) internal pure returns (uint256 remainingAmount) {
        // Calculate the minimum amount of junior assets required to maintain the senior : junior ratio.
        // Since integer division rounds down, add 1 to minJuniorAmount in order to maintain the ratio.
        uint256 minJuniorAmount = trancheAssets[SENIOR_TRANCHE_INDEX] / maxSeniorJuniorRatio;
        if (minJuniorAmount * maxSeniorJuniorRatio < trancheAssets[SENIOR_TRANCHE_INDEX])
            minJuniorAmount += 1;
        // console.log(
        //     "minJuniorAmounts: %s, tranches[SENIOR_TRANCHE_INDEX]: %s",
        //     minJuniorAmounts,
        //     tranches[SENIOR_TRANCHE_INDEX]
        // );

        uint256 maxRedeemableAmount = trancheAssets[JUNIOR_TRANCHE_INDEX] > minJuniorAmount
            ? trancheAssets[JUNIOR_TRANCHE_INDEX] - minJuniorAmount
            : 0;
        if (maxRedeemableAmount <= 0) return availableAmount;

        uint256 endIndex = epochsRange.startIndex + epochsRange.length;
        for (uint256 i = epochsRange.startIndex; i < endIndex; i++) {
            EpochRedemptionSummary memory redemptionSummary = epochRedemptionSummaries[i];
            uint256 sharesToRedeem = redemptionSummary.totalSharesRequested - redemptionSummary.totalSharesProcessed;
            uint256 redemptionAmount = (sharesToRedeem * lpTokenPrice) / DEFAULT_DECIMALS_FACTOR;
            if (availableAmount < redemptionAmount) {
                redemptionAmount = availableAmount;
            }
            if (maxRedeemableAmount < redemptionAmount) {
                redemptionAmount = maxRedeemableAmount;
            }

            sharesToRedeem = (redemptionAmount * DEFAULT_DECIMALS_FACTOR) / lpTokenPrice;
            redemptionSummary.totalSharesProcessed += uint96(sharesToRedeem);
            redemptionSummary.totalAmountProcessed += uint96(redemptionAmount);
            availableAmount -= redemptionAmount;
            maxRedeemableAmount -= redemptionAmount;
            trancheAssets[JUNIOR_TRANCHE_INDEX] -= uint96(redemptionAmount);

            // If the redemption requests in the epoch were partially processed in the last round,
            // then they will be processed again in this round (by decrementing `epochsRange.startIndex` by 1 in
            // `_executeEpoch`, which means the same epoch would be double-counted if we simply increment the count
            // by 1 all the time, hence the conditional increment only if the value of `i` satisfies the condition
            // below.
            if (i > processingResult.numEpochsProcessed - 1) processingResult.numEpochsProcessed += 1;
            processingResult.sharesRedeemed += sharesToRedeem;
            processingResult.amountRedeemed += redemptionAmount;

            if (availableAmount == 0 || maxRedeemableAmount == 0) break;
        }

        remainingAmount = availableAmount;
    }
}
