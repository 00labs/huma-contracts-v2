// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "./SharedDefs.sol";
import {IERC20MetadataUpgradeable, ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {TrancheVaultStorage, IERC20} from "./TrancheVaultStorage.sol";
import {IEpoch, EpochRedemptionSummary} from "./interfaces/IEpoch.sol";
import {IEpochManager} from "./interfaces/IEpochManager.sol";
import {Errors} from "./Errors.sol";
import {PoolConfig, LPConfig} from "./PoolConfig.sol";
import {PoolConfigCacheUpgradeable} from "./PoolConfigCacheUpgradeable.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract TrancheVault is
    AccessControlUpgradeable,
    ERC20Upgradeable,
    PoolConfigCacheUpgradeable,
    TrancheVaultStorage,
    IEpoch
{
    bytes32 public constant LENDER_ROLE = keccak256("LENDER");

    event LiquidityDeposited(address indexed account, uint256 assetAmount, uint256 shareAmount);

    event RedemptionRequestAdded(address indexed account, uint256 shareAmount, uint256 epochId);
    event RedemptionRequestRemoved(address indexed account, uint256 shareAmount, uint256 epochId);

    event EpochsProcessed(
        uint256 epochCount,
        uint256 sharesProcessed,
        uint256 amountProcessed,
        uint256 unprocessedIndexOfEpochIds
    );

    event LenderFundDisbursed(address indexed account, address receiver, uint256 withdrawnAmount);

    constructor() {
        // _disableInitializers();
    }

    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external initializer {
        __ERC20_init(name, symbol);
        __AccessControl_init();

        poolConfig = _poolConfig;

        if (seniorTrancheOrJuniorTranche > 1) revert Errors.invalidTrancheIndex();
        trancheIndex = seniorTrancheOrJuniorTranche;

        _updatePoolConfigData(_poolConfig);
    }

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);
        _decimals = IERC20MetadataUpgradeable(addr).decimals();

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);

        addr = _poolConfig.poolVault();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolVault = IPoolVault(addr);

        addr = _poolConfig.epochManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        epochManager = IEpochManager(addr);
    }

    /**
     * @notice Lenders need to pass compliance requirements. Pool operator will administer off-chain
     * to make sure potential lenders meet the requirements. Afterwards, the pool operator will
     * call this function to mark a lender as approved.
     */
    function addApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _grantRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Disables a lender. This prevents the lender from making more deposits.
     * The capital that the lender has contributed can continue to work as normal.
     */
    function removeApprovedLender(address lender) external {
        poolConfig.onlyPoolOperator(msg.sender);
        if (lender == address(0)) revert Errors.zeroAddressProvided();
        _revokeRole(LENDER_ROLE, lender);
    }

    /**
     * @notice Returns the redemption summary for all unprocessed/partially processed epochs.
     */
    function unprocessedEpochSummaries() external view override returns (EpochRedemptionSummary[] memory summaries) {
        uint256 numUnprocessedEpochs = epochIds.length - firstUnprocessedEpochIndex;
        summaries = new EpochRedemptionSummary[](numUnprocessedEpochs);
        for (uint256 i; i < numUnprocessedEpochs; i++) {
            summaries[i] = epochRedemptionSummaryByEpochId[epochIds[firstUnprocessedEpochIndex + i]];
        }
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function totalSupply() public view override returns (uint256) {
        return ERC20Upgradeable.totalSupply();
    }

    /**
     * @notice Updates processed epochs
     */
    function processEpochs(
        EpochRedemptionSummary[] memory epochsProcessed,
        uint256 sharesProcessed,
        uint256 amountProcessed
    ) external {
        poolConfig.onlyEpochManager(msg.sender);

        uint256 numEpochsProcessed = epochsProcessed.length;
        EpochRedemptionSummary memory epochRedemptionSummary;
        for (uint256 i; i < numEpochsProcessed; i++) {
            epochRedemptionSummary = epochsProcessed[i];
            epochRedemptionSummaryByEpochId[epochRedemptionSummary.epochId] = epochRedemptionSummary;
        }

        uint256 unprocessedIndex = firstUnprocessedEpochIndex;
        if (epochRedemptionSummary.totalSharesProcessed >= epochRedemptionSummary.totalSharesRequested) {
            // If the last epoch is fully processed, then advance the index by the number of processed epochs.
            // It's theoretically impossible for the number of processed shares to be greater than the
            // requested shares. The > is just to make the linter happy.
            assert(epochRedemptionSummary.totalSharesProcessed == epochRedemptionSummary.totalSharesRequested);
            unprocessedIndex += numEpochsProcessed;
        } else if (numEpochsProcessed > 1) {
            // Otherwise, point the index at the last partially processed epoch.
            unprocessedIndex += numEpochsProcessed - 1;
        }
        firstUnprocessedEpochIndex = unprocessedIndex;

        // Burn processed shares of LP tokens.
        ERC20Upgradeable._burn(address(this), sharesProcessed);
        // Withdraw underlying tokens from the reserve so that LPs can redeem.
        poolVault.withdraw(address(this), amountProcessed);

        emit EpochsProcessed(numEpochsProcessed, sharesProcessed, amountProcessed, unprocessedIndex);
    }

    /**
     * @notice LP deposits to the pool to earn interest, and share losses
     *
     * @notice All deposits should be made by calling this function and
     * makeInitialDeposit() (for pool owner and EA's initial deposit) only.
     * Please do NOT directly transfer any digital assets to the contracts,
     * which will cause a permanent loss and we cannot help reverse transactions
     * or retrieve assets from the contracts.
     *
     * @param assets the number of underlyingToken to be deposited
     * @param receiver the address to receive the minted tranche token
     * @return shares the number of tranche token to be minted
     */
    function deposit(uint256 assets, address receiver) external returns (uint256 shares) {
        if (assets == 0) revert Errors.zeroAmountProvided();
        if (receiver == address(0)) revert Errors.zeroAddressProvided();
        _onlyLender(msg.sender);
        _onlyLender(receiver);
        poolConfig.onlyProtocolAndPoolOn();
        return _deposit(assets, receiver);
    }

    function _deposit(uint256 assets, address receiver) internal returns (uint256 shares) {
        uint256 cap = poolConfig.getTrancheLiquidityCap(trancheIndex);
        if (assets > cap) {
            revert Errors.poolLiquidityCapExceeded();
        }
        uint96[2] memory tranches = pool.refreshPool();
        uint256 trancheAssets = tranches[trancheIndex];
        if (trancheAssets + assets > cap) {
            revert Errors.poolLiquidityCapExceeded();
        }

        if (trancheIndex == SENIOR_TRANCHE_INDEX) {
            // Make sure that the max senior : junior asset ratio is still intact.
            LPConfig memory lpConfig = poolConfig.getLPConfig();
            if ((trancheAssets + assets) > tranches[JUNIOR_TRANCHE_INDEX] * lpConfig.maxSeniorJuniorRatio)
                revert Errors.maxSeniorJuniorRatioExceeded();
        }

        poolVault.deposit(msg.sender, assets);

        shares = _convertToShares(assets, trancheAssets);
        ERC20Upgradeable._mint(receiver, shares);

        tranches[trancheIndex] += uint96(assets);
        pool.updateTrancheAssets(tranches);

        emit LiquidityDeposited(receiver, assets, shares);
    }

    /**
     * @notice Records a new redemption request
     */
    function addRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        uint256 sharesBalance = ERC20Upgradeable.balanceOf(msg.sender);
        if (shares > sharesBalance) {
            revert Errors.withdrawnAmountHigherThanBalance(); // assets is too big
        }

        uint256 currentEpochId = epochManager.currentEpochId();
        EpochRedemptionSummary memory currentEpochInfo = epochRedemptionSummaryByEpochId[currentEpochId];
        if (currentEpochInfo.totalSharesRequested > 0) {
            // If the current epoch already has redemption requests, then add the new redemption request
            // to it.
            currentEpochInfo.totalSharesRequested += uint96(shares);
        } else {
            // Otherwise, record the current epoch ID in `epochIds` since there are now redemption requests,
            // and record the redemption request data in the global registry.
            epochIds.push(currentEpochId);
            currentEpochInfo.epochId = uint64(currentEpochId);
            currentEpochInfo.totalSharesRequested = uint96(shares);
        }
        epochRedemptionSummaryByEpochId[currentEpochId] = currentEpochInfo;

        // Also log the redemption request in the per-lender registry.
        RedemptionRequest[] storage requests = redemptionRequestsByLender[msg.sender];
        uint256 numRequests = requests.length;
        RedemptionRequest memory request;
        if (numRequests > 0) {
            request = requests[numRequests - 1];
        }
        if (request.epochId == currentEpochId) {
            // If the request already exists, merge the new request with the existing one.
            request.numSharesRequested += uint96(shares);
            requests[numRequests - 1] = request;
        } else {
            // Otherwise, create a new request.
            request.epochId = uint64(currentEpochId);
            request.numSharesRequested = uint96(shares);
            requests.push(request);
        }

        ERC20Upgradeable._transfer(msg.sender, address(this), shares);

        emit RedemptionRequestAdded(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Cancels a previous redemption request of the specified number of shares.
     */
    function cancelRedemptionRequest(uint256 shares) external {
        if (shares == 0) revert Errors.zeroAmountProvided();
        poolConfig.onlyProtocolAndPoolOn();

        RedemptionRequest[] storage requests = redemptionRequestsByLender[msg.sender];
        uint256 numRequests = requests.length;
        if (numRequests == 0) revert Errors.emptyArray();
        uint256 lastIndex = numRequests - 1;
        RedemptionRequest memory request = requests[lastIndex];
        uint256 currentEpochId = epochManager.currentEpochId();
        if (request.epochId < currentEpochId) {
            // Redemption requests from previous epochs cannot be removed.
            revert Errors.notCurrentEpoch();
        }
        if (request.numSharesRequested < shares) {
            revert Errors.insufficientSharesForRequest();
        }

        request.numSharesRequested -= uint96(shares);
        if (request.numSharesRequested > 0) {
            requests[lastIndex] = request;
        } else {
            delete requests[lastIndex];
        }

        EpochRedemptionSummary memory currentEpochInfo = epochRedemptionSummaryByEpochId[currentEpochId];
        currentEpochInfo.totalSharesRequested -= uint96(shares);
        if (currentEpochInfo.totalSharesRequested > 0) {
            epochRedemptionSummaryByEpochId[currentEpochId] = currentEpochInfo;
        } else {
            // Since we don't keep track of epochs w/o redemption requests, clean them up.
            delete epochRedemptionSummaryByEpochId[currentEpochId];
            lastIndex = epochIds.length - 1;
            assert(epochIds[lastIndex] == currentEpochId);
            delete epochIds[lastIndex];
        }

        ERC20Upgradeable._transfer(address(this), msg.sender, shares);

        emit RedemptionRequestRemoved(msg.sender, shares, currentEpochId);
    }

    /**
     * @notice Transfers the full redeemable amount to the lender
     */
    function disburse(address receiver) external {
        poolConfig.onlyProtocolAndPoolOn();

        (uint256 withdrawableAmount, RedemptionDisbursementInfo memory disbursementInfo) = _getWithdrawableAmountForLender(
            msg.sender
        );
        redemptionDisbursementInfoByLender[msg.sender] = disbursementInfo;

        underlyingToken.transfer(receiver, withdrawableAmount);

        emit LenderFundDisbursed(msg.sender, receiver, withdrawableAmount);
    }

    /**
     * @notice Returns the withdrawable assets value of the given account
     */
    function withdrawableAssets(address account) external view returns (uint256 assets) {
        (assets, ) = _getWithdrawableAmountForLender(account);
    }

    function cancellableRedemptionShares(address account) external view returns (uint256 shares) {
        RedemptionRequest[] storage requests = redemptionRequestsByLender[account];
        uint256 numRequests = requests.length;
        if (numRequests > 0) {
            uint256 lastIndex = requests.length - 1;
            RedemptionRequest memory request = requests[lastIndex];
            uint256 currentEpochId = epochManager.currentEpochId();
            if (request.epochId == currentEpochId) {
                RedemptionDisbursementInfo memory disbursementInfo = redemptionDisbursementInfoByLender[account];
                if (
                    disbursementInfo.requestsIndex == lastIndex &&
                    disbursementInfo.actualSharesProcessed > 0
                ) {
                    // shares = 0;
                } else {
                    shares = request.numSharesRequested;
                }
            }
        }
    }

    function totalAssets() public view returns (uint256) {
        return pool.trancheTotalAssets(trancheIndex);
    }

    function convertToShares(uint256 assets) external view returns (uint256 shares) {
        shares = _convertToShares(assets, totalAssets());
    }

    function getNumEpochsWithRedemption() external view returns (uint256) {
        return epochIds.length;
    }

    function getNumRedemptionRequests(address account) external view returns (uint256) {
        return redemptionRequestsByLender[account].length;
    }

    function _convertToShares(
        uint256 _assets,
        uint256 _totalAssets
    ) internal view returns (uint256 shares) {
        // TODO solve the first tiny deposit vector - https://github.com/spearbit/portfolio/blob/master/pdfs/MapleV2.pdf

        uint256 supply = ERC20Upgradeable.totalSupply();

        return supply == 0 ? _assets : (_assets * supply) / _totalAssets;
    }

    function _updateUserWithdrawable(address user) internal returns (uint256 withdrableAmount) {}

    /**
     * @notice Calculates withdrawable amount from the last index of user redemption request array
     * to current processed user redemption request
     */
    function _getWithdrawableAmountForLender(
        address account
    ) internal view returns (uint256 withdrawableAmount, RedemptionDisbursementInfo memory disbursementInfo) {
        disbursementInfo = redemptionDisbursementInfoByLender[account];
        RedemptionRequest[] storage requests = redemptionRequestsByLender[account];
        uint256 numEpochsWithRedemption = epochIds.length;
        uint256 epochIdsIndex = firstUnprocessedEpochIndex;
        uint256 firstUnprocessedEpochId = epochIdsIndex < numEpochsWithRedemption
            ? epochIds[epochIdsIndex]
            : epochIds[numEpochsWithRedemption - 1] + 1;

        for (uint256 i = disbursementInfo.requestsIndex; i < requests.length; i++) {
            RedemptionRequest memory request = requests[i];
            if (request.epochId < firstUnprocessedEpochId) {
                // The redemption requests in the epoch have been fully processed.
                EpochRedemptionSummary memory epoch = epochRedemptionSummaryByEpochId[request.epochId];
                // TODO There will be one decimal unit of rounding error here if it can't be divisible.
                uint256 sharesProcessed = (request.numSharesRequested * epoch.totalSharesProcessed) /
                    epoch.totalSharesRequested;
                uint256 amountProcessed = (request.numSharesRequested * epoch.totalAmountProcessed) /
                    epoch.totalSharesRequested;
                if (disbursementInfo.actualSharesProcessed > 0) {
                    sharesProcessed -= disbursementInfo.actualSharesProcessed;
                    amountProcessed -= disbursementInfo.actualAmountProcessed;
                    disbursementInfo.actualSharesProcessed = 0;
                    disbursementInfo.actualAmountProcessed = 0;
                }

                // Bug? Should this be amountProcessed?
                withdrawableAmount += amountProcessed;
                disbursementInfo.requestsIndex += 1;
            } else if (request.epochId == firstUnprocessedEpochId) {
                // The redemption requests in the epoch have been partially processed or unprocessed.
                EpochRedemptionSummary memory epoch = epochRedemptionSummaryByEpochId[request.epochId];
                if (epoch.totalSharesProcessed > 0) {
                    uint256 sharesProcessed = (request.numSharesRequested * epoch.totalSharesProcessed) /
                        epoch.totalSharesRequested;
                    uint256 amountProcessed = (request.numSharesRequested *
                        epoch.totalAmountProcessed) / epoch.totalSharesRequested;
                    withdrawableAmount += amountProcessed - disbursementInfo.actualAmountProcessed;
                    disbursementInfo.actualSharesProcessed = uint96(sharesProcessed);
                    disbursementInfo.actualAmountProcessed = uint96(amountProcessed);
                }
                break;
            } else {
                // It's impossible for the request epoch ID to exceed the unprocessed epoch ID.
                assert(false);
            }
        }
    }

    function _onlyLender(address account) internal view {
        if (!hasRole(LENDER_ROLE, account)) revert Errors.permissionDeniedNotLender();
    }
}
