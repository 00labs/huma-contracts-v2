// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig, FirstLossCoverConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";
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
     * @notice turns on the pool. Only the pool owner or protocol owner can enable a pool.
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
     * @notice turns off the pool. Any pool operator can do so when they see abnormalities.
     */
    function disablePool() external {
        poolConfig.onlyPoolOperator(msg.sender);
        _status = PoolStatus.Off;
        emit PoolDisabled(msg.sender);
    }

    function setReadyForFirstLossCoverWithdrawal(bool ready) external {
        poolConfig.onlyOwnerOrHumaMasterAdmin(msg.sender);
        readyForFirstLossCoverWithdrawal = ready;
        emit PoolReadyForFirstLossCoverWithdrawal(msg.sender, ready);
    }

    /// Gets the on/off status of the pool
    function isPoolOn() external view returns (bool status) {
        return _status == PoolStatus.On;
    }

    /// @inheritdoc IPool
    function distributeProfit(uint256 profit) external {
        // TODO(jiatu): add pool tests for non-authorized callers.
        _onlyCreditOrCreditManager(msg.sender);
        _distributeProfit(profit);
    }

    /// @inheritdoc IPool
    function distributeLoss(uint256 loss) external {
        _onlyCreditOrCreditManager(msg.sender);
        _distributeLoss(loss);
    }

    /// @inheritdoc IPool
    function distributeLossRecovery(uint256 lossRecovery) external {
        if (msg.sender != address(credit)) revert Errors.notAuthorizedCaller();
        _distributeLossRecovery(lossRecovery);
    }

    function _distributeProfit(uint256 profit) internal {
        TranchesAssets memory assets = tranchesAssets;

        uint256 poolProfit = feeManager.distributePoolFees(profit);

        if (poolProfit > 0) {
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

            // Don't call _updateTranchesAssets() here because tranchePolicy.refreshData() has already
            // been called in distProfitToTranches().
            tranchesAssets = TranchesAssets({
                seniorTotalAssets: newAssets[SENIOR_TRANCHE],
                juniorTotalAssets: newAssets[JUNIOR_TRANCHE]
            });
            emit ProfitDistributed(profit, newAssets[SENIOR_TRANCHE], newAssets[JUNIOR_TRANCHE]);
        }
    }

    function _distributeProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal returns (uint256 newJuniorTotalAssets) {
        if (profit == 0) return juniorTotalAssets;
        (
            uint256 juniorProfit,
            uint256[16] memory profitsForFirstLossCovers
        ) = _calcProfitForFirstLossCovers(profit, juniorTotalAssets);
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

    function _calcProfitForFirstLossCovers(
        uint256 profit,
        uint256 juniorTotalAssets
    ) internal view returns (uint256 juniorProfit, uint256[16] memory profitsForFirstLossCovers) {
        if (profit == 0) return (juniorProfit, profitsForFirstLossCovers);
        uint256 len = _firstLossCovers.length;
        uint256 totalWeight = juniorTotalAssets;
        for (uint256 i = 0; i < len; i++) {
            IFirstLossCover cover = _firstLossCovers[i];
            // We use profitsForFirstLossCovers to store the effective amount of assets of first loss covers so that
            // we don't have to create another array, which helps to save on gas.
            FirstLossCoverConfig memory config = poolConfig.getFirstLossCoverConfig(
                address(cover)
            );
            profitsForFirstLossCovers[i] = cover.totalAssets() * config.riskYieldMultiplier;
            totalWeight += profitsForFirstLossCovers[i];
        }
        juniorProfit = profit;
        for (uint256 i = 0; i < len; i++) {
            profitsForFirstLossCovers[i] = (profit * profitsForFirstLossCovers[i]) / totalWeight;
            // Note that juniorProfit is always positive because `totalWeight` consists both junior assets
            // and risk adjusted assets from each first loss cover. Thus we don't need to check whether
            // `juniorProfit` ever reaches 0.
            juniorProfit -= profitsForFirstLossCovers[i];
        }
    }

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

            uint256 numFirstLossCovers = _firstLossCovers.length;
            for (uint256 i = 0; i < numFirstLossCovers && remainingLossRecovery > 0; i++) {
                IFirstLossCover cover = _firstLossCovers[numFirstLossCovers - i - 1];
                remainingLossRecovery = cover.recoverLoss(remainingLossRecovery);
            }
        }
    }

    function trancheTotalAssets(uint256 index) external view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[index];
    }

    function totalAssets() public view returns (uint256) {
        uint96[2] memory assets = currentTranchesAssets();
        return assets[SENIOR_TRANCHE] + assets[JUNIOR_TRANCHE];
    }

    function currentTranchesAssets() public view returns (uint96[2] memory assets) {
        TranchesAssets memory tempTranchesAssets = tranchesAssets;
        return [tempTranchesAssets.seniorTotalAssets, tempTranchesAssets.juniorTotalAssets];
    }

    function updateTranchesAssets(uint96[2] memory assets) external {
        _onlyTrancheVaultOrEpochManager(msg.sender);
        _updateTranchesAssets(assets);
    }

    function getFirstLossCovers() external view returns (IFirstLossCover[] memory) {
        return _firstLossCovers;
    }

    function _updateTranchesAssets(uint96[2] memory assets) internal {
        tranchesAssets = TranchesAssets({
            seniorTotalAssets: assets[SENIOR_TRANCHE],
            juniorTotalAssets: assets[JUNIOR_TRANCHE]
        });
        tranchesPolicy.refreshData(assets);
    }

    /// @inheritdoc IPool
    function getFirstLossCoverAvailableCap(
        address coverAddress,
        uint256 poolAssets
    ) external view returns (uint256 availableCap) {
        IFirstLossCover cover = IFirstLossCover(coverAddress);
        return _getFirstLossCoverAvailableCap(cover, poolAssets);
    }

    function _getFirstLossCoverAvailableCap(
        IFirstLossCover cover,
        uint256 poolAssets
    ) internal view returns (uint256 availableCap) {
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
