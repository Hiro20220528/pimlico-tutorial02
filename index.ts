import dotenv from "dotenv"
import { getAccountNonce } from "permissionless"
import { UserOperation, bundlerActions, getSenderAddress, getUserOperationHash, waitForUserOperationReceipt, GetUserOperationReceiptReturnType } from "permissionless"
import { pimlicoBundlerActions, pimlicoPaymasterActions } from "permissionless/actions/pimlico"
import { Address, Hash, concat, createClient, createPublicClient, encodeFunctionData, http, Hex } from "viem"
import { generatePrivateKey, privateKeyToAccount, signMessage } from "viem/accounts"
import { lineaTestnet, polygonMumbai } from "viem/chains"
dotenv.config();

console.log("Hello world!");

const privateKey = dotenv.config().parsed?.PRIVATE_KEY || ""; // replace this with a private key you generate!
const apiKey = dotenv.config().parsed?.PRIVATE_KEY || ""; // replace with your Pimlico API key

const ENTRY_POINT_ADDRESS = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";
const SIMPLE_ACCOUNT_FACTORY_ADDRESS = "0x9406Cc6185a346906296840746125a0E44976454";

const chain = "mumbai";

if (apiKey === undefined) {
    throw new Error("Please replace the `apiKey` env variable with your Pimlico API key");
};

if (privateKey.match(/GENERATED_PRIVATE_KEY/)) {
    throw new Error(
        "Please replace the `privateKey` variable with a newly generated private key. You can use `generatePrivateKey()` for this"
    );
};

const signer = privateKeyToAccount(privateKey as Hash);
// console.log("signer", signer);

const bundlerClient = createClient({
    transport: http(`https://api.pimlico.io/v1/${chain}/rpc?apikey=${apiKey}`),
    chain: polygonMumbai
}).extend(bundlerActions).extend(pimlicoBundlerActions);

const paymasterClient = createClient({
    // ⚠️ using v2 of the API ⚠️
    transport: http(`https://api.pimlico.io/v2/${chain}/rpc?apikey=${apiKey}`),
    chain: polygonMumbai
}).extend(pimlicoPaymasterActions);

const publicClient = createPublicClient({
    transport: http("https://rpc-mumbai.maticvigil.com/"),
    // transport: http("https://mumbai.rpc.thirdweb.com"),
    chain: polygonMumbai
});

// CALCULATE THE DETERMINISTIC SENDER ADDRESS
const initCode = concat([
    SIMPLE_ACCOUNT_FACTORY_ADDRESS,
    encodeFunctionData({
        abi: [
            {
                inputs: [
                    { name: "owner", type: "address" },
                    { name: "salt", type: "uint256" }
                ],
                name: "createAccount",
                outputs: [{ name: "ret", type: "address" }],
                stateMutability: "nonpayable",
                type: "function"
            }
        ],
        args: [signer.address, 0n]
    })
]);

// 一意にアドレスを導出する
const senderAddress = await getSenderAddress(publicClient, {
    initCode,
    entryPoint: ENTRY_POINT_ADDRESS
});

console.log("Counterfactual sender address:", senderAddress);

/**
 * *******************************************************************************************
 */

// DEPLOY THE SIMPLE WALLET
const genereteApproveCallData = (erc20TokenAddress: Address, paymasterAddress: Address) => {
    const approveData = encodeFunctionData({
        abi: [
            {
                inputs: [
                    { name: "_spender", type: "address" },
                    { name: "_value", type: "uint256" }
                ],
                name: "approve",
                outputs: [{ name: "", type: "bool" }],
                payable: false,
                stateMutability: "nonpayable",
                type: "function"
            }
        ],
        args: [paymasterAddress, 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn]
    });

    // GENERATE THE CALLDATA TO APPROVE THE USDC
    const to = erc20TokenAddress;
    const value = 0n;
    const data = approveData;

    const callData = encodeFunctionData({
        abi: [
            {
                inputs: [
                    { name: "dest", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "func", type: "bytes" }
                ],
                name: "execute",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function"
            }
        ],
        args: [to, value, data]
    });

    return callData
}

const submitUserOperation = async (userOperation: UserOperation) => {
    const userOperationHash = await bundlerClient.sendUserOperation({
        userOperation,
        entryPoint: ENTRY_POINT_ADDRESS
    });
    console.log(`UserOperation submitted. Hash: ${userOperationHash}`);

    console.log("Querying for receipts...")
    const receipt = await bundlerClient.waitForUserOperationReceipt({
        hash: userOperationHash
    });
    console.log(`Receipt found!\nTransaction hash: ${receipt.receipt.transactionHash}`);
}

// You can get the paymaster addresses from https://docs.pimlico.io/reference/erc20-paymaster/contracts
const erc20PaymasterAddress = "0x32aCDFeA07a614E52403d2c1feB747aa8079A353";
const usdcTokenAddress = "0x0fa8781a83e46826621b3bc094ea2a0212e71b23"; // USDC on Polygon Mumbai

const senderUsdcBalance = await publicClient.readContract({
    abi: [
        {
            inputs: [{ name: "_owner", type: "address" }],
            name: "balanceOf",
            outputs: [{ name: "balance", type: "uint256" }],
            type: "function",
            stateMutability: "view"
        }
    ],
    address: usdcTokenAddress,
    functionName: "balanceOf",
    args: [senderAddress]
});

console.log("senderUsdcBalance", senderUsdcBalance);

if (senderUsdcBalance < 1_000_000n) {
    throw new Error(
        `insufficient USDC balance for counterfactual wallet address ${senderAddress}: ${Number(senderUsdcBalance) / 1000000
        } USDC, required at least 1 USDC`
    );
}

const approveCallData = genereteApproveCallData(usdcTokenAddress, erc20PaymasterAddress)

// FILL OUT THE REMAINING USEROPERATION VALUES
const gasPriceResult = await bundlerClient.getUserOperationGasPrice();

const userOperation: Partial<UserOperation> = {
    sender: senderAddress,
    nonce: 0n,
    initCode,
    callData: approveCallData,
    maxFeePerGas: gasPriceResult.fast.maxFeePerGas,
    maxPriorityFeePerGas: gasPriceResult.fast.maxPriorityFeePerGas,
    paymasterAndData: "0x",
    signature: "0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c"
}

const nonce = await getAccountNonce(publicClient, {
    entryPoint: ENTRY_POINT_ADDRESS,
    sender: senderAddress
});
// 2回目のトランザクションとして

if (nonce === 0n) {
    // SPONSOR THE USEROPERATION USING THE VERIFYING PAYMASTER
    const result = await paymasterClient.sponsorUserOperation({
        userOperation: userOperation as UserOperation,
        entryPoint: ENTRY_POINT_ADDRESS
    });
    userOperation.preVerificationGas = result.preVerificationGas;
    userOperation.verificationGasLimit = result.verificationGasLimit;
    userOperation.callGasLimit = result.callGasLimit;
    userOperation.paymasterAndData = result.paymasterAndData;
    // SIGN THE USEROPERATION
    const signature = await signMessage({
        message: {
            raw: getUserOperationHash({
                userOperation: userOperation as UserOperation,
                entryPoint: ENTRY_POINT_ADDRESS,
                chainId: polygonMumbai.id
            })
        },
        privateKey: privateKey as Hash
    });
    userOperation.signature = signature;
    await submitUserOperation(userOperation as UserOperation);
} else {
    console.log("Deployment UserOperation previously submitted, skipping...");
    console.log("UserOperation", userOperation);
    userOperation.initCode = "0x";
    userOperation.nonce = nonce;
    // SPONSOR THE USEROPERATION USING THE VERIFYING PAYMASTER
    const result = await paymasterClient.sponsorUserOperation({
        userOperation: userOperation as UserOperation,
        entryPoint: ENTRY_POINT_ADDRESS
    });
    userOperation.preVerificationGas = result.preVerificationGas;
    userOperation.verificationGasLimit = result.verificationGasLimit;
    userOperation.callGasLimit = result.callGasLimit;
    userOperation.paymasterAndData = result.paymasterAndData;
    // SIGN THE USEROPERATION
    const signature = await signMessage({
        message: {
            raw: getUserOperationHash({
                userOperation: userOperation as UserOperation,
                entryPoint: ENTRY_POINT_ADDRESS,
                chainId: polygonMumbai.id
            })
        },
        privateKey: privateKey as Hash
    });
    userOperation.signature = signature;
    await submitUserOperation(userOperation as UserOperation);
};