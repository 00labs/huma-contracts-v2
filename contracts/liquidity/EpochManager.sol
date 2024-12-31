// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

import {IPool} from "./interfaces/IPool.sol";
import {PoolConfig, PoolSettings, LPConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {IRedemptionHandler, EpochRedemptionSummary} from "./interfaces/IRedemptionHandler.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {DEFAULT_DECIMALS_FACTOR, JUNIOR_TRANCHE, SENIOR_TRANCHE} from "../common/SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "../common/Errors.sol";
import {ICalendar} from "../common/interfaces/ICalendar.sol";
import {IERC20Metadata, IERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title EpochManager
 * @notice EpochManager processes redemption requests at the end of each billing cycle.
 */
contract EpochManager is PoolConfigCache, IEpochManager {
    /**
     * @notice Information about the current epoch.
     * @param id The ID of the current epoch.
     * @param endTime The time when the current epoch should end.
     */
    struct CurrentEpoch {
        uint64 id;
        uint64 endTime;
    }

    /**
     * The minimum balance required in the pool to process redemption requests. This threshold is set to avoid rounding
     * errors when the pool's balance is too low.
     */
    uint256 private constant _MIN_POOL_BALANCE_FOR_REDEMPTION = 1;
    /**
     * The actual threshold required for redemption based on the number of decimals
     * of the underlying token of the pool. The value will be calculated and cached during initialization.
     */
    uint256 public minPoolBalanceForRedemption;

    IPool public pool;
    IPoolSafe public poolSafe;
    IRedemptionHandler public seniorTranche;
    IRedemptionHandler public juniorTranche;
    ICalendar public calendar;

    CurrentEpoch internal _currentEpoch;

    /**
     * @notice The current epoch has closed.
     * @param epochId The ID of the epoch that just closed.
     */
    event EpochClosed(uint256 epochId);

    /**
     * @notice A new epoch has started.
     * @param epochId The ID of the epoch that just started.
     * @param endTime The time when the current epoch should end.
     */
    event NewEpochStarted(uint256 epochId, uint256 endTime);

    /**
     * @notice The epoch has been processed after the pool is closed.
     * @param epochId The ID of the epoch that has been processed.
     */
    event EpochProcessedAfterPoolClosure(uint256 epochId);

    /**
     * @notice Pending redemption requests have been processed.
     * @param seniorTrancheAssets The total amount of assets in the senior tranche.
     * @param seniorTranchePrice The LP token price of the senior tranche.
     * @param juniorTrancheAssets The total amount of assets in the junior tranche.
     * @param juniorTranchePrice The LP token price of the junior tranche.
     * @param unprocessedAmount The amount of assets requested for redemption but the system was not able to fulfill.
     */
    event RedemptionRequestsProcessed(
        uint256 seniorTrancheAssets,
        uint256 seniorTranchePrice,
        uint256 juniorTrancheAssets,
        uint256 juniorTranchePrice,
        uint256 unprocessedAmount
    );

    /// @inheritdoc IEpochManager
    function startNewEpoch() external {
        poolConfig.onlyPool(msg.sender);

        CurrentEpoch memory ce = _currentEpoch;
        EpochRedemptionSummary memory seniorSummary = seniorTranche.epochRedemptionSummary(ce.id);
        if (seniorSummary.totalSharesRequested > 0) {
            seniorTranche.executeRedemptionSummary(seniorSummary);
        }
        EpochRedemptionSummary memory juniorSummary = juniorTranche.epochRedemptionSummary(ce.id);
        if (juniorSummary.totalSharesRequested > 0) {
            juniorTranche.executeRedemptionSummary(juniorSummary);
        }

        ce.endTime = 0;
        _createNextEpoch(ce);
    }

    /// @inheritdoc IEpochManager
    function closeEpoch() external virtual {
        poolConfig.onlyProtocolAndPoolOn();

        CurrentEpoch memory ce = _currentEpoch;
        if (block.timestamp <= ce.endTime) revert Errors.EpochClosedTooEarly();

        _processRedemptionRequests(ce.id);
        emit EpochClosed(ce.id);

        _createNextEpoch(ce);
    }

    /// @inheritdoc IEpochManager
    function processEpochAfterPoolClosure() external {
        poolConfig.onlyPool(msg.sender);
        if (!pool.isPoolClosed()) revert Errors.PoolIsNotClosed();

        uint256 currentEpochId_ = _currentEpoch.id;
        _processRedemptionRequests(currentEpochId_);
        emit EpochProcessedAfterPoolClosure(currentEpochId_);
    }

    function copyStorageDataFromOldContract() external {
        poolConfig.onlyPoolOwner(msg.sender);

        EpochManager oldEpochManager = EpochManager(0x1a2C87Be5e785493310526faA7739Bbe4E10c0F6);
        CurrentEpoch memory oldCurrentEpoch = oldEpochManager.currentEpoch();
        _currentEpoch = oldCurrentEpoch;
    }

    /// @inheritdoc IEpochManager
    function currentEpochId() external view returns (uint256) {
        return _currentEpoch.id;
    }

    function currentEpoch() external view returns (CurrentEpoch memory) {
        return _currentEpoch;
    }

    /**
     * @notice Syndicates the address of dependent contracts from pool config.
     */
    function _updatePoolConfigData(PoolConfig poolConfig_) internal virtual override {
        address addr = poolConfig_.poolSafe();
        assert(addr != address(0));
        poolSafe = IPoolSafe(addr);

        addr = poolConfig_.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = poolConfig_.seniorTranche();
        assert(addr != address(0));
        seniorTranche = IRedemptionHandler(addr);

        addr = poolConfig_.juniorTranche();
        assert(addr != address(0));
        juniorTranche = IRedemptionHandler(addr);

        addr = poolConfig_.calendar();
        assert(addr != address(0));
        calendar = ICalendar(addr);

        addr = poolConfig_.underlyingToken();
        assert(addr != address(0));
        uint256 decimals = IERC20Metadata(addr).decimals();

        minPoolBalanceForRedemption = _MIN_POOL_BALANCE_FOR_REDEMPTION * 10 ** decimals;
    }

    function _createNextEpoch(CurrentEpoch memory epoch) internal {
        epoch.id += 1;
        PoolSettings memory poolSettings = poolConfig.getPoolSettings();
        uint256 nextEndTime = calendar.getStartDateOfNextPeriod(
            poolSettings.payPeriodDuration,
            epoch.endTime
        );
        epoch.endTime = uint64(nextEndTime);
        _currentEpoch = epoch;

        emit NewEpochStarted(epoch.id, epoch.endTime);
    }

    function _processRedemptionRequests(uint256 epochId) internal {
        if (
            poolSafe.unprocessedTrancheProfit(address(seniorTranche)) != 0 ||
            poolSafe.unprocessedTrancheProfit(address(juniorTranche)) != 0
        ) {
            // Unprocessed profit may lead to suboptimal redemption processing since it's reserved in the pool safe
            // and cannot be used for redemption processing. Revert to ensure yield distribution happen before
            // redemption processing.
            revert Errors.RedemptionsCannotBeProcessedDueToUnprocessedProfit();
        }

        uint96[2] memory tranchesAssets = pool.currentTranchesAssets();
        // Get unprocessed redemption requests.
        EpochRedemptionSummary memory seniorSummary = seniorTranche.epochRedemptionSummary(
            epochId
        );
        EpochRedemptionSummary memory juniorSummary = juniorTranche.epochRedemptionSummary(
            epochId
        );

        if (seniorSummary.totalSharesRequested == 0 && juniorSummary.totalSharesRequested == 0) {
            // Early return if there is no redemption request.
            return;
        }

        // Calculate senior/junior LP token prices.
        // In a uni-tranche pool, the senior tranche is disabled, so the senior supply will be 0.
        // Set the senior token price to 0 if that's the case.
        uint256 seniorSupply = IERC20(address(seniorTranche)).totalSupply();
        uint256 seniorPrice = seniorSupply == 0
            ? 0
            : (tranchesAssets[SENIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) / seniorSupply;
        // The junior supply will never be zero due to the pool owner min deposit requirement.
        uint256 juniorPrice = (tranchesAssets[JUNIOR_TRANCHE] * DEFAULT_DECIMALS_FACTOR) /
            IERC20(address(juniorTranche)).totalSupply();

        _processEpoch(tranchesAssets, seniorSummary, seniorPrice, juniorSummary, juniorPrice);

        // Calculate the amount of assets that lenders requested to redeem, but the system was not able to
        // fulfill due to various constraints.
        uint256 unprocessedAmount = (((seniorSummary.totalSharesRequested -
            seniorSummary.totalSharesProcessed) * seniorPrice) +
            ((juniorSummary.totalSharesRequested - juniorSummary.totalSharesProcessed) *
                juniorPrice)) / DEFAULT_DECIMALS_FACTOR;

        if (seniorSupply > 0) {
            // Skip the senior tranche if it's disabled.
            seniorTranche.executeRedemptionSummary(seniorSummary);
        }
        juniorTranche.executeRedemptionSummary(juniorSummary);

        pool.updateTranchesAssets(tranchesAssets);

        emit RedemptionRequestsProcessed(
            tranchesAssets[SENIOR_TRANCHE],
            seniorPrice / DEFAULT_DECIMALS_FACTOR,
            tranchesAssets[JUNIOR_TRANCHE],
            juniorPrice / DEFAULT_DECIMALS_FACTOR,
            unprocessedAmount
        );
    }

    /**
     * @notice Processes previously unprocessed redemption requests.
     * @param tranchesAssets Tranches assets indexed by SENIOR_ and JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets.
     * @param seniorSummary Unprocessed/partially processed RedemptionSummary for the senior tranche.
     * @param seniorPrice The senior LP token price.
     * @param juniorSummary Unprocessed/partially processed RedemptionSummary for the junior tranche.
     * @param juniorPrice The junior LP token price.
     * @dev This function is side-effectual and mutates the following incoming params:
     * 1. tranchesAssets: will be updated to reflect the remaining amount of assets in the tranches after processing
     * redemption requests.
     * 2. seniorSummary: will be updated to reflect the latest redemption request state for the senior tranche.
     * 3. juniorSummary: will be updated to reflect the latest redemption request state for the junior tranche.
     */
    function _processEpoch(
        uint96[2] memory tranchesAssets,
        EpochRedemptionSummary memory seniorSummary,
        uint256 seniorPrice,
        EpochRedemptionSummary memory juniorSummary,
        uint256 juniorPrice
    ) internal view {
        // Get the available balance in the pool that can be used to process redemption requests.
        uint256 availableAmount = poolSafe.getAvailableBalanceForPool();
        if (availableAmount <= minPoolBalanceForRedemption) return;

        // Process senior tranche redemption requests. In a uni-tranche pool, there will be no shares requested
        // in the senior tranche, so redemption processing will be skipped.
        if (seniorSummary.totalSharesRequested > 0) {
            availableAmount = _processSeniorRedemptionRequests(
                tranchesAssets,
                seniorPrice,
                seniorSummary,
                availableAmount
            );

            if (availableAmount <= minPoolBalanceForRedemption) {
                return;
            }
        }

        // Process junior tranche redemption requests.
        if (juniorSummary.totalSharesRequested > 0) {
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            uint256 maxSeniorJuniorRatio = lpConfig.maxSeniorJuniorRatio;
            availableAmount = _processJuniorRedemptionRequests(
                tranchesAssets,
                juniorPrice,
                maxSeniorJuniorRatio,
                juniorSummary,
                availableAmount
            );
        }
    }

    /**
     * @notice Processes redemption requests for the senior tranche.
     * @param tranchesAssets Tranches assets indexed by SENIOR_ and JUNIOR_TRANCHE.
     * @param lpTokenPrice The price of the senior LP tokens.
     * @param redemptionSummary RedemptionSummary for the senior tranche.
     * @param availableAmount The total amount available for redemption.
     * @dev This function is side-effectual and mutates the following incoming params:
     * 1. tranchesAssets: will be updated to reflect the remaining amount of assets in the senior tranche.
     * 2. redemptionSummary: will be updated to reflect the latest redemption request states for the senior tranche.
     */
    function _processSeniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        EpochRedemptionSummary memory redemptionSummary,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        uint256 sharesToRedeem = redemptionSummary.totalSharesRequested;
        uint256 redemptionAmountWithDecimal = sharesToRedeem * lpTokenPrice;
        uint256 availableAmountWithDecimal = availableAmount * DEFAULT_DECIMALS_FACTOR;
        if (availableAmountWithDecimal < redemptionAmountWithDecimal) {
            redemptionAmountWithDecimal = availableAmountWithDecimal;
            // Round up the number of shares to make sure it is enough for redemptionAmount
            sharesToRedeem = Math.ceilDiv(redemptionAmountWithDecimal, lpTokenPrice);
        }
        uint256 redemptionAmount = redemptionAmountWithDecimal / DEFAULT_DECIMALS_FACTOR;
        redemptionSummary.totalSharesProcessed = uint96(sharesToRedeem);
        redemptionSummary.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;

        tranchesAssets[SENIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }

    /**
     * @notice Processes redemption requests for the junior tranche. When processing junior requests, special care
     * has to be taken to ensure that the max senior : junior ratio is not breached.
     * @param tranchesAssets Tranches assets indexed by SENIOR_ and JUNIOR_TRANCHE, i.e. tranches[0] is the
     * senior tranche assets and tranches[1] is the junior tranche assets.
     * @param lpTokenPrice The price of the junior LP tokens.
     * @param maxSeniorJuniorRatio The max senior : junior asset ratio that needs to be maintained.
     * @param redemptionSummary RedemptionSummary for the junior tranche.
     * @param availableAmount The total amount available for redemption.
     * @dev This function is side-effectual and mutates the following incoming params:
     * 1. tranchesAssets: will be updated to reflect the remaining amount of assets in the junior tranche.
     * 2. redemptionSummary: will be updated to reflect the latest redemption request states for the senior tranche.
     */
    function _processJuniorRedemptionRequests(
        uint96[2] memory tranchesAssets,
        uint256 lpTokenPrice,
        uint256 maxSeniorJuniorRatio,
        EpochRedemptionSummary memory redemptionSummary,
        uint256 availableAmount
    ) internal pure returns (uint256 remainingAmount) {
        uint256 minJuniorAmount = 0;
        if (maxSeniorJuniorRatio != 0) {
            // Round up the junior asset to make sure the senior : junior ratio is maintained.
            minJuniorAmount = Math.ceilDiv(tranchesAssets[SENIOR_TRANCHE], maxSeniorJuniorRatio);
        }

        uint256 maxRedeemableAmount = tranchesAssets[JUNIOR_TRANCHE] > minJuniorAmount
            ? tranchesAssets[JUNIOR_TRANCHE] - minJuniorAmount
            : 0;
        if (maxRedeemableAmount <= 0) return availableAmount;

        uint256 sharesToRedeem = redemptionSummary.totalSharesRequested;
        uint256 redemptionAmountWithDecimal = sharesToRedeem * lpTokenPrice;
        uint256 maxRedeemableAmountWithDecimal = Math.min(availableAmount, maxRedeemableAmount) *
            DEFAULT_DECIMALS_FACTOR;
        if (maxRedeemableAmountWithDecimal < redemptionAmountWithDecimal) {
            // Recalculate the number of shares to redeem using the remaining balance in the pool if it's
            // lower than the amount requested.
            redemptionAmountWithDecimal = maxRedeemableAmountWithDecimal;
            // Following the favoring-the-pool principle from ERC4626, round up the number of shares the lender
            // has to burn for the amount they wish to receive.
            sharesToRedeem = Math.ceilDiv(redemptionAmountWithDecimal, lpTokenPrice);
        }

        uint256 redemptionAmount = redemptionAmountWithDecimal / DEFAULT_DECIMALS_FACTOR;

        redemptionSummary.totalSharesProcessed = uint96(sharesToRedeem);
        redemptionSummary.totalAmountProcessed = uint96(redemptionAmount);
        availableAmount -= redemptionAmount;
        tranchesAssets[JUNIOR_TRANCHE] -= uint96(redemptionAmount);

        remainingAmount = availableAmount;
    }
}
