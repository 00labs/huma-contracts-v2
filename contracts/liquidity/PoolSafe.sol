// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "../common/Errors.sol";
import {PoolConfig} from "../common/PoolConfig.sol";
import {PoolConfigCache} from "../common/PoolConfigCache.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title PoolSafe
 * @notice PoolSafe tracks the in flow and out flow of underlying tokens.
 */
contract PoolSafe is PoolConfigCache, IPoolSafe {
    using SafeERC20 for IERC20;

    IERC20 public underlyingToken;
    IPool public pool;
    IPoolFeeManager public poolFeeManager;

    address public seniorTranche;
    address public juniorTranche;
    address public credit;
    address public poolFeeManager;

    /**
     * Maps tranche addresses to unprocessed profits.
     * The key is junior/senior tranche address, the value is the unprocessed profit.
     */
    mapping(address => uint256) public unprocessedTrancheProfit;

    /**
     * @inheritdoc IPoolSafe
     * @custom:access Only contracts that are approved to move money can access this function
     */
    function deposit(address from, uint256 amount) external virtual {
        _onlySystemMoneyMover(msg.sender);

        underlyingToken.safeTransferFrom(from, address(this), amount);
    }

    /**
     * @inheritdoc IPoolSafe
     * @custom:access Only contracts that are approved to move money can access this function
     */
    function withdraw(address to, uint256 amount) external virtual {
        if (to == address(0)) revert Errors.ZeroAddressProvided();
        _onlySystemMoneyMover(msg.sender);

        underlyingToken.safeTransfer(to, amount);
    }

    /// @inheritdoc IPoolSafe
    function addUnprocessedProfit(address tranche, uint256 profit) external {
        if (msg.sender != address(pool)) revert Errors.AuthorizedContractCallerRequired();
        if (tranche != seniorTranche && tranche != juniorTranche) revert Errors.TrancheRequired();
        unprocessedTrancheProfit[tranche] += profit;
    }

    /// @inheritdoc IPoolSafe
    function resetUnprocessedProfit() external {
        if (msg.sender != seniorTranche && msg.sender != juniorTranche)
            revert Errors.AuthorizedContractCallerRequired();
        unprocessedTrancheProfit[msg.sender] = 0;
    }

    /// @inheritdoc IPoolSafe
    function getAvailableBalanceForPool()
        external
        view
        virtual
        returns (uint256 availableBalance)
    {
        // Deducts balance reserved for unprocessed yield and balance reserved for admin fees.
        uint256 reserved = poolFeeManager.getTotalAvailableFees();
        reserved +=
            unprocessedTrancheProfit[poolConfig.seniorTranche()] +
            unprocessedTrancheProfit[poolConfig.juniorTranche()];
        uint256 balance = underlyingToken.balanceOf(address(this));
        availableBalance = balance > reserved ? balance - reserved : 0;
    }

    /// @inheritdoc IPoolSafe
    function totalBalance() external view returns (uint256 liquidity) {
        liquidity = underlyingToken.balanceOf(address(this));
    }

    /// @inheritdoc IPoolSafe
    function getAvailableBalanceForFees() external view returns (uint256 availableBalance) {
        // Deducts balance reserved for unprocessed yield.
        uint256 reserved = unprocessedTrancheProfit[poolConfig.seniorTranche()] +
            unprocessedTrancheProfit[poolConfig.juniorTranche()];
        uint256 balance = underlyingToken.balanceOf(address(this));
        availableBalance = balance > reserved ? balance - reserved : 0;
    }

    /// Utility function to cache the dependent contract addresses.
    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        assert(addr != address(0));
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        assert(addr != address(0));
        poolFeeManager = IPoolFeeManager(addr);

        addr = _poolConfig.pool();
        assert(addr != address(0));
        pool = IPool(addr);

        addr = _poolConfig.seniorTranche();
        assert(addr != address(0));
        seniorTranche = addr;

        addr = _poolConfig.juniorTranche();
        assert(addr != address(0));
        juniorTranche = addr;

        addr = _poolConfig.credit();
        assert(addr != address(0));
        credit = addr;

        addr = _poolConfig.poolFeeManager();
        assert(addr != address(0));
        poolFeeManager = addr;
    }

    /**
     * @notice Checks if the given account is one of the contracts that are approved to transfer funds.
     * @dev Only the TrancheVault contracts for senior and junior tranches, the Credit contract
     * the PoolFeeManager contract, and FirstLossCover contracts are allowed to move money.
     */
    function _onlySystemMoneyMover(address account) internal view {
        if (
            account != seniorTranche &&
            account != juniorTranche &&
            account != credit &&
            account != poolFeeManager &&
            !poolConfig.isFirstLossCover(account)
        ) revert Errors.AuthorizedContractCallerRequired();
    }
}
