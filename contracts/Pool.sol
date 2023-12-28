// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, FirstLossCoverConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE, HUNDRED_PERCENT_IN_BPS} from "./SharedDefs.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {IFirstLossCover} from "./interfaces/IFirstLossCover.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {ITranchesPolicy} from "./interfaces/ITranchesPolicy.sol";
import {ICreditManager} from "./credit/interfaces/ICreditManager.sol";
import {ICredit} from "./credit/interfaces/ICredit.sol";

/**
 * @title Pool
 * @notice Pool is a core contract that connects the lender side (via Tranches)
 * and the borrower side (via Credit)
 */
contract Pool is PoolConfigCache, IPool {
    struct TranchesAssets {
        uint96 seniorTotalAssets; // total assets of senior tranche
        uint96 juniorTotalAssets; // total assets of junior tranche
    }

    struct TranchesLosses {
        uint96 seniorLoss; // total losses of senior tranche
        uint96 juniorLoss; // total losses of junior tranche
    }

    enum PoolStatus {
        Off,
        On
    }

    IEpochManager public epochManager;
    IFirstLossCover[] internal _firstLossCovers;
    IPoolFeeManager public feeManager;
    IPoolSafe public poolSafe;
    ITranchesPolicy public tranchesPolicy;
    ICredit public credit;
    ICreditManager public creditManager;

    TranchesAssets public tranchesAssets;
    TranchesLosses public tranchesLosses;

    // Whether the pool is ON or OFF
    PoolStatus internal _status;

    bool public readyForFirstLossCoverWithdrawal;

    event PoolDisabled(address indexed by);
    event PoolEnabled(address indexed by);
    event PoolReadyForFirstLossCoverWithdrawal(address indexed by, bool ready);

    event PoolAssetsRefreshed(
        uint256 refreshedTimestamp,
        uint256 profit,
        uint256 loss,
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    event ProfitDistributed(uint256 profit, uint256 seniorTotalAssets, uint256 juniorTotalAssets);
    event LossDistributed(
        uint256 loss,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );
    event LossRecoveryDistributed(
        uint256 lossRecovery,
        uint256 seniorTotalAssets,
        uint256 juniorTotalAssets,
        uint256 seniorTotalLoss,
        uint256 juniorTotalLoss
    );

    /**
     * @notice Common function in Huma protocol to retrieve contract addresses from PoolConfig.
     * Pool contract references PoolSafe, PoolFeeManager, TranchePolicy, EpochManager, Credit,
     * CreditManager, and FirstLossCover.
     */
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.poolSafe();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolSafe = IPoolSafe(addr);

        addr = _poolConfig.tranchesPolicy();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        tranchesPolicy = ITranchesPolicy(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        feeManager = IPoolFeeManager(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);

        addr = _poolConfig.credit();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        credit = ICredit(addr);

        addr = _poolConfig.creditManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        creditManager = ICreditManager(addr);

        address[16] memory covers = _poolConfig.getFirstLossCovers();
        for (uint256 i = 0; i < covers.length; i++) {
            if (covers[i] != address(0)) _firstLossCovers.push(IFirstLossCover(covers[i]));
            else break;
        }
    }

    /**
     * @notice Turns on the pool. Before a pool is turned on, the required First loss cover
     * and liquidity must be deposited first.
     * @custom:access Only the pool owner or protocol owner can enable a pool.
     */
    function enablePool() external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        poolConfig.checkFirstLossCoverRequirementsForAdmin();
        poolConfig.checkLiquidityRequirements();

        epochManager.startNewEpoch();
        _status = PoolStatus.On;
        emit PoolEnabled(msg.sender);
    }

    /**
     * @notice Disables the pool. Once a pool is disabled, no money moves in or out.
     * @custom:accss Any pool operator can disable a pool. Only the pool owner or Huma protocol
     * owner can enable it again.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    /**
     * @notice Enables or disables the first loss cover investors to withdraw capital
     * @custom:access Only pool owner or Huma protocol owner can call this function.
     */
    function setReadyForFirstLossCoverWithdrawal(bool isReady) external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        readyForFirstLossCoverWithdrawal = isReady;
        emit PoolReadyForFirstLossCoverWithdrawal(msg.sender, isReady);
    }

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        return _status == PoolStatus.On;
    }

    function getTrancheAvailableCap(uint256 index) external view returns (uint256 availableCap) {
        if (index != SENIOR_TRANCHE && index != JUNIOR_TRANCHE) return 0;
        LPConfig memory config = poolConfig.getLPConfig();
        uint96[2] memory assets = currentTranchesAssets();
        uint256 poolAssets = assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
        availableCap = config.liquidityCap > poolAssets ? config.liquidityCap - poolAssets : 0;
        if (index == SENIOR_TRANCHE) {
            uint256 seniorAvailableCap = assets[JUNIOR_TRANCHE] *
                config.maxSeniorJuniorRatio -
                assets[SENIOR_TRANCHE];
            availableCap = availableCap > seniorAvailableCap ? seniorAvailableCap : availableCap;
        }
    }

    /// custom:access only Credit or CreditManager contract can call this function.
    /// @inheritdoc IPool
    function distributeProfit(uint256 profit) external {
        // TODO(jiatu): add pool tests for non-authorized callers.
        _onlyCreditOrCreditManager(msg.sender);
        _distributeProfit(profit);
    }

    /// custom:access only Credit or CreditManager contract can call this function.
    /// @inheritdoc IPool
    function distributeLoss(uint256 loss) external {
        // TODO: Check if there are tests for non-authorized callers.
        _onlyCreditOrCreditManager(msg.sender);
        _distributeLoss(loss);
    }

    /// custom:access Only Credit contract can call this function
    /// @inheritdoc IPool
    function distributeLossRecovery(uint256 lossRecovery) external {
        if (msg.sender != address(credit)) revert Errors.notAuthorizedCaller();
        _distributeLossRecovery(lossRecovery);
    }

    /**
     * @notice Internal function that distributes profit to admins, senior and junior tranches,
     * and first loss covers in this sequence.
     * @param profit the amount of profit to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeProfit(uint256 profit) internal {
        TranchesAssets memory assets = tranchesAssets;

        // distributes to pool admins first
        uint256 poolProfit = feeManager.distributePoolFees(profit);

        if (poolProfit > 0) {
            // distributes to junior and senior tranches
            // TODO It is confusing to allocate profits for FLCs and Junior to Junior tranche
            // first, then distribute it to FLC and have the remainer for Junior. Prefer
            // distProfitToTranches to return results for tranches and FLCs.
            uint96[2] memory newAssets = tranchesPolicy.distProfitToTranches(
                poolProfit,
                [assets.seniorTotalAssets, assets.juniorTotalAssets]
            );
            poolSafe.addUnprocessedProfit(
                poolConfig.seniorTranche(),
                newAssets[SENIOR_TRANCHE] - assets.seniorTotalAssets
            );

            // Distribute profit to first loss covers using profits in the junior tranche.
            if (newAssets[JUNIOR_TRANCHE] > assets.juniorTotalAssets) {
                newAssets[JUNIOR_TRANCHE] = uint96(
                    _distributeProfitForFirstLossCovers(
                        newAssets[JUNIOR_TRANCHE] - assets.juniorTotalAssets,
                        assets.juniorTotalAssets
                    )
                );
                poolSafe.addUnprocessedProfit(
                    poolConfig.juniorTranche(),
                    newAssets[JUNIOR_TRANCHE] - assets.juniorTotalAssets
                );
            }

            // Don't call _updateTranchesAssets() here because yield tracker has already
            // been updated in distProfitToTranches().
            // TODO Not sure if it is a good practice to update state in tranchesPolicy.
            // Let us discuss we need to change it.
            tranchesAssets = TranchesAssets({
                seniorTotalAssets: newAssets[SENIOR_TRANCHE],
                juniorTotalAssets: newAssets[JUNIOR_TRANCHE]
            });
            emit ProfitDistributed(profit, newAssets[SENIOR_TRANCHE], newAssets[JUNIOR_TRANCHE]);
        }
    }

    /**
     * @notice Internal function that distributes profit to first loss cover providers.
     * @param nonSeniorProfit the amount of profit to be distributed between FLC and junior tranche
     * @param juniorTotalAssets the total asset amount for junior tranche
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeProfitForFirstLossCovers(
        uint256 nonSeniorProfit,
        uint256 juniorTotalAssets
    ) internal returns (uint256 newJuniorTotalAssets) {
        if (nonSeniorProfit == 0) return juniorTotalAssets;
        (
            uint256 juniorProfit,
            uint256[16] memory profitsForFirstLossCovers
        ) = _calcProfitForFirstLossCovers(nonSeniorProfit, juniorTotalAssets);
        uint256 len = _firstLossCovers.length;
        for (uint256 i = 0; i < len; i++) {
            if (profitsForFirstLossCovers[i] == 0) {
                continue;
            }
            IFirstLossCover cover = _firstLossCovers[i];
            cover.addCoverAssets(profitsForFirstLossCovers[i]);
        }
        newJuniorTotalAssets = juniorTotalAssets + juniorProfit;
    }

    /**
     * @notice Internal function that calculates profit to first loss cover (FLC) providers
     * @dev There is a risk multiplier assigned to each first loss cover. To compute the profit
     * for each PLCs, we first gets the product of the asset amount of each PLC and the risk
     * multiplier, then add them together. We then proportionally allocate the profit to each
     * PLC based on its product of asset amount and risk multiplier. The remainer is left
     * for the junior tranche.
     * @param nonSeniorProfit the amount of profit to be distributed between FLC and junior tranche
     * @param juniorTotalAssets the total asset amount for junior tranche
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _calcProfitForFirstLossCovers(
        uint256 nonSeniorProfit,
        uint256 juniorTotalAssets
    ) internal view returns (uint256 juniorProfit, uint256[16] memory profitsForFirstLossCovers) {
        if (nonSeniorProfit == 0) return (juniorProfit, profitsForFirstLossCovers);
        uint256 len = _firstLossCovers.length;

        // TotalWeight is the sume of the product of asset amount and risk multiplier for each FLC
        // and the junior tranche.
        uint256 totalWeight = juniorTotalAssets;
        for (uint256 i = 0; i < len; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            // profitsForFirstLossCovers is re-used to store the product of asset amount and risk
            // multiplier for each PLC for gas optimization by saving an array creation
            FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(
                address(cover)
            );
            profitsForFirstLossCovers[i] =
                (cover.totalAssets() * config.riskYieldMultiplierInBps) /
                HUNDRED_PERCENT_IN_BPS;
            totalWeight += profitsForFirstLossCovers[i];
        }

        juniorProfit = nonSeniorProfit;
        for (uint256 i = 0; i < len; i++) {
            profitsForFirstLossCovers[i] =
                (nonSeniorProfit * profitsForFirstLossCovers[i]) /
                totalWeight;
            // Note since profitsForFirstLossCovers[i] is rounding down by default,
            // it is guranteed that juniorProfit will not
            juniorProfit -= profitsForFirstLossCovers[i];
        }
        return (juniorProfit, profitsForFirstLossCovers);
    }

    /**
     * @notice Utility function that distributes loss to different tranches。
     * The loss is distributed to first loss cover first, then junior tranche, and senior tranche
     * @param loss the amount of loss to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeLoss(uint256 loss) internal {
        if (loss > 0) {
            uint256 coverCount = _firstLossCovers.length;
            for (uint256 i = 0; i < coverCount && loss > 0; i++) {
                loss = _firstLossCovers[i].coverLoss(loss);
            }

            if (loss > 0) {
                // If there are losses remaining, let the junior and senior tranches cover the losses.
                TranchesAssets memory assets = tranchesAssets;
                (uint96[2] memory newAssets, uint96[2] memory lossesDelta) = tranchesPolicy
                    .distLossToTranches(
                        loss,
                        [assets.seniorTotalAssets, assets.juniorTotalAssets]
                    );
                _updateTranchesAssets(newAssets);

                TranchesLosses memory losses = tranchesLosses;
                losses.seniorLoss += lossesDelta[SENIOR_TRANCHE];
                losses.juniorLoss += lossesDelta[JUNIOR_TRANCHE];
                tranchesLosses = losses;

                emit LossDistributed(
                    loss,
                    newAssets[SENIOR_TRANCHE],
                    newAssets[JUNIOR_TRANCHE],
                    losses.seniorLoss,
                    losses.juniorLoss
                );
            }
        }
    }

    /**
     * @notice Utility function that distributes loss recovery to different tranches and
     * First Loss Covers (FLCs). The distribution sequence is: senior tranche, junior tranche,
     * followed by FLCs
     * @param lossRecovery the amount of loss to be distributed
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _distributeLossRecovery(uint256 lossRecovery) internal {
        if (lossRecovery > 0) {
            TranchesAssets memory assets = tranchesAssets;
            TranchesLosses memory losses = tranchesLosses;
            (
                uint256 remainingLossRecovery,
                uint96[2] memory newAssets,
                uint96[2] memory newLosses
            ) = tranchesPolicy.distLossRecoveryToTranches(
                    lossRecovery,
                    [assets.seniorTotalAssets, assets.juniorTotalAssets],
                    [losses.seniorLoss, losses.juniorLoss]
                );
            _updateTranchesAssets(newAssets);
            tranchesLosses = TranchesLosses({
                seniorLoss: newLosses[SENIOR_TRANCHE],
                juniorLoss: newLosses[JUNIOR_TRANCHE]
            });
            emit LossRecoveryDistributed(
                lossRecovery - remainingLossRecovery,
                newAssets[SENIOR_TRANCHE],
                newAssets[JUNIOR_TRANCHE],
                newLosses[SENIOR_TRANCHE],
                newLosses[JUNIOR_TRANCHE]
            );

            // Distributes the remainder to First Loss Covers.
            uint256 numFirstLossCovers = _firstLossCovers.length;
            for (uint256 i = 0; i < numFirstLossCovers && remainingLossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[numFirstLossCovers - i - 1];
                remainingLossRecovery = cover.recoverLoss(remainingLossRecovery);
            }
        }
    }

    /**
     * @notice Gets the total asset of a tranche
     * @param index the tranche index.
     * @return the total asset of the tranche.
     */
    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    /**
     * @notice Gets the combined total asset of junior tranche and senior tranche.
     * @return - the total asset of both junior and senior tranches
     */
    function totalAssets() public view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
    }

    /**
     * @notice Gets the assets for each tranch
     * @return assets the tranche assets in an array.
     */
    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        return [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
    }

    /**
     * @notice Updates the tranche assets with the given asset values
     * @param assets an array that represents the tranche asset
     * @custom:access Only TrancheVault or Epoch Manager can call this function
     */
    function updateTranchesAssets(uint96[2] memory assets) external {
        _onlyTrancheVaultOrEpochManager(msg.sender);
        _updateTranchesAssets(assets);
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    /**
     * @notice Utility function to update tranche assets
     * @param assets an array that represents the descired tranche asset
     * @custom:access Internal function without access restriction. Caller needs to control access
     */
    function _updateTranchesAssets(uint96[2] memory assets) internal {
        tranchesAssets = TranchesAssets({
            seniorTotalAssets: assets[SENIOR_TRANCHE],
            juniorTotalAssets: assets[JUNIOR_TRANCHE]
        });
        tranchesPolicy.refreshYieldTracker(assets);
    }

    /// @inheritdoc IPool
    function getFirstLossCoverAvailableCap(
        address coverAddress,
        uint256 poolAssets
    ) external view returns (uint256 availableCap) {
        IFirstLossCover cover = IFirstLossCover(coverAddress);
        uint256 coverTotalAssets = cover.totalAssets();
        uint256 totalCap = cover.getCapacity(poolAssets);
        return totalCap > coverTotalAssets ? totalCap - coverTotalAssets : 0;
    }

    function _onlyTrancheVaultOrEpochManager(address account) internal view {
        if (
            account != poolConfig.juniorTranche() &&
            account != poolConfig.seniorTranche() &&
            account != poolConfig.epochManager()
        ) revert Errors.notAuthorizedCaller();
    }

    function _onlyCreditOrCreditManager(address account) internal view {
        if (account != address(credit) && account != address(creditManager)) {
            revert Errors.notAuthorizedCaller();
        }
    }
}
