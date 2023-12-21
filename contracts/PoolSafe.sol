// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {Errors} from "./Errors.sol";
import {PoolConfig} from "./PoolConfig.sol";
import {PoolConfigCache} from "./PoolConfigCache.sol";
import {IPoolFeeManager} from "./interfaces/IPoolFeeManager.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {JUNIOR_TRANCHE, SENIOR_TRANCHE} from "./SharedDefs.sol";

/**
 * @title PoolSafe
 * @notice PoolSafe tracks the in flow and out flow of underlying tokens
 */
contract PoolSafe is PoolConfigCache, IPoolSafe {
    using SafeERC20 for IERC20;

    IERC20 public underlyingToken;
    IPool public pool;
    IPoolFeeManager public poolFeeManager;

    // This mapping contains the unprocessed profit for junior tranche and senior tranche.
    // The key is junior/senior tranche address, the value is the unprocessed profit.
    mapping(address => uint256) public unprocessedTrancheProfit;

    function _updatePoolConfigData(PoolConfig _poolConfig) internal virtual override {
        address addr = _poolConfig.underlyingToken();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        underlyingToken = IERC20(addr);

        addr = _poolConfig.poolFeeManager();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        poolFeeManager = IPoolFeeManager(addr);

        addr = _poolConfig.pool();
        if (addr == address(0)) revert Errors.zeroAddressProvided();
        pool = IPool(addr);
    }

    /// @inheritdoc IPoolSafe
    function deposit(address from, uint256 amount) external virtual {
        _onlyCustodian(msg.sender);

        underlyingToken.safeTransferFrom(from, address(this), amount);
    }

    /// @inheritdoc IPoolSafe
    function withdraw(address to, uint256 amount) external virtual {
        if (to == address(0)) revert Errors.zeroAddressProvided();
        _onlyCustodian(msg.sender);

        underlyingToken.safeTransfer(to, amount);
    }

    /// @inheritdoc IPoolSafe
    function addUnprocessedProfit(address tranche, uint256 profit) external {
        if (msg.sender != address(pool)) revert Errors.notPool();
        if (tranche != poolConfig.seniorTranche() && tranche != poolConfig.juniorTranche())
            revert Errors.todo();
        unprocessedTrancheProfit[tranche] += profit;
    }

    /// @inheritdoc IPoolSafe
    function resetUnprocessedProfit() external {
        if (msg.sender != poolConfig.seniorTranche() && msg.sender != poolConfig.juniorTranche())
            revert Errors.notAuthorizedCaller();
        unprocessedTrancheProfit[msg.sender] = 0;
    }

    /// @inheritdoc IPoolSafe
    function getAvailableBalanceForPool()
        external
        view
        virtual
        returns (uint256 availableBalance)
    {
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
        uint256 reserved = unprocessedTrancheProfit[poolConfig.seniorTranche()] +
            unprocessedTrancheProfit[poolConfig.juniorTranche()];
        uint256 balance = underlyingToken.balanceOf(address(this));
        availableBalance = balance > reserved ? balance - reserved : 0;
    }

    function _onlyCustodian(address account) internal view {
        if (
            account != poolConfig.seniorTranche() &&
            account != poolConfig.juniorTranche() &&
            account != poolConfig.credit() &&
            account != poolConfig.poolFeeManager() &&
            !poolConfig.isFirstLossCover(account)
        ) revert Errors.notAuthorizedCaller();
    }
}
